import { PrometheusTelemetry } from '../../src/infrastructure/observability/telemetry';
import type { Telemetry } from '../../src/application/telemetry';
import { expect,test } from 'bun:test';
import { randomUUID,createHash } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateQueueCommand,DeleteQueueCommand,GetQueueAttributesCommand,SendMessageCommand,ReceiveMessageCommand,DeleteMessageCommand,type SQSClient } from '@aws-sdk/client-sqs';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { Migration202610260001FinancialSchema } from '../../src/infrastructure/persistence/migrations/Migration202610260001FinancialSchema';
import { Migration202610260002BalanceLimit } from '../../src/infrastructure/persistence/migrations/Migration202610260002BalanceLimit';
import { financialServices } from '../../src/infrastructure/persistence/financial-services';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/mikro-financial-unit-of-work';
import { ProcessWagerTransaction } from '../../src/application/financial-use-cases';
import type { FinancialUnitOfWork } from '../../src/application/financial-ports';
import { WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { prepareSqsWagerRequest } from '../../src/application/wager-request';
import { OutboxStore } from '../../src/infrastructure/persistence/outbox-store';
import { localSqsClient,localQueueUrl } from '../../src/infrastructure/messaging/local-sqs';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';

async function fixture(work: (f: { orm: MikroORM; schema: string; s: string; client: SQSClient; source: string; dlq: string; events: string;
  consumer: (process?: ProcessWagerTransaction,options?: { maxReceives?: number; telemetry?: Telemetry; afterCommit?: () => Promise<void> }) => SqsWagerConsumer;
  publisher: (client?: SQSClient,options?: { telemetry?: Telemetry; afterPublish?: () => Promise<void> }) => OutboxPublisher }) => Promise<void>,fifoEvents = true) {
  const schema=`bb_test_${randomUUID().replaceAll('-','')}`; const s=`"${schema}"`; const config=persistenceConfig();
  const orm=await MikroORM.init({ ...config,schema,migrations: { ...config.migrations,tableName: `${schema}.mikro_orm_migrations`,migrationsList: [
    { name: 'Migration202610260001FinancialSchema',class: Migration202610260001FinancialSchema },
    { name: 'Migration202610260002BalanceLimit',class: Migration202610260002BalanceLimit },
  ] } });
  const client=localSqsClient(); const queues: string[]=[]; const workers: (SqsWagerConsumer | OutboxPublisher)[]=[];
  const create=async (name: string,attrs: Record<string,string>) => {
    await client.send(new CreateQueueCommand({ QueueName: name,Attributes: attrs }));
    const url=await localQueueUrl(client,name); queues.push(url); return url;
  };
  try {
    await orm.em.getConnection().execute(`create schema ${s}`); await orm.getMigrator().up();
    const suffix=randomUUID(); const dlq=await create(`bb-test-${suffix}-dlq.fifo`,{ FifoQueue: 'true' });
    const arn=(await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq,AttributeNames: ['QueueArn'] }))).Attributes!.QueueArn!;
    const source=await create(`bb-test-${suffix}.fifo`,{ FifoQueue: 'true',VisibilityTimeout: '1',RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn,maxReceiveCount: '5' }) });
    const events=await create(`bb-test-${suffix}-events${fifoEvents ? '.fifo' : ''}`,fifoEvents ? { FifoQueue: 'true' } : {});
    await work({ orm,schema,s,client,source,dlq,events,
      consumer: (process=financialServices(orm).process,options={}) => {
        const worker=new SqsWagerConsumer(client,process,{ queueUrl: source,dlqUrl: dlq,visibilitySeconds: 1,...options }); workers.push(worker); return worker;
      },publisher: (sender=client,options={}) => {
        const worker=new OutboxPublisher(new OutboxStore(orm),sender,{ queueUrl: events,...options }); workers.push(worker); return worker;
      } });
  } finally {
    try {
      await Promise.all(workers.map(worker => worker.stop(0)));
      for (const QueueUrl of queues.reverse()) await client.send(new DeleteQueueCommand({ QueueUrl }));
    } finally {
      client.destroy();
      try { await orm.em.getConnection().execute(`drop schema if exists ${s} cascade`); }
      finally { await orm.close(true); }
    }
  }
}
async function open(orm: MikroORM,amount='100.00') {
  return financialServices(orm).openWallet.execute({ playerId: randomUUID(),initialBalance: { amount,currency: 'BRL' } });
}
function envelope(w: { id: string; playerId: string },kind='BET',amount='25.00') {
  return { messageId: randomUUID(),type: 'WagerTransactionRequested',occurredAt: new Date().toISOString(),data: {
    providerId: 'provider-a',externalTransactionId: randomUUID(),idempotencyKey: randomUUID(),playerId: w.playerId,walletId: w.id,
    roundId: 'round',gameId: 'game',kind,money: { amount,currency: 'BRL' },
  } };
}
async function send(client: SQSClient,url: string,value: unknown,group: string=randomUUID()) {
  return client.send(new SendMessageCommand({ QueueUrl: url,MessageBody: typeof value === 'string' ? value : JSON.stringify(value),
    MessageGroupId: group,MessageDeduplicationId: randomUUID() }));
}
async function drain(client: SQSClient,url: string,waitSeconds=1) {
  const messages=[];
  for (let i=0;i<10;i++) {
    const result=await client.send(new ReceiveMessageCommand({ QueueUrl: url,MaxNumberOfMessages: 10,WaitTimeSeconds: waitSeconds,MessageAttributeNames: ['All'] }));
    if (!result.Messages?.length) break;
    for (const message of result.Messages) {
      messages.push(message);
      await client.send(new DeleteMessageCommand({ QueueUrl: url,ReceiptHandle: message.ReceiptHandle! }));
    }
  }
  return messages;
}
async function assertBalance(orm: MikroORM,s: string,id: string,expected: string) {
  const [row]=await orm.em.getConnection().execute<{ balance: string; calculated: string }[]>(`select w.balance::numeric(20,2)::text as balance,
    coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end),0)::numeric(20,2)::text as calculated
    from ${s}.wallets w left join ${s}.wallet_ledger l on l.wallet_id=w.id where w.id=? group by w.id`,[id]);
  expect(row?.balance).toBe(expected); expect(row?.calculated).toBe(expected);
}
async function count(orm: MikroORM,s: string,table: string) {
  const [row]=await orm.em.getConnection().execute<{ n: number }[]>(`select count(*)::int as n from ${s}.${table}`); return row!.n;
}
async function crashChild(schema: string,mode: string,queue: string,dlq: string) {
  const child=Bun.spawn([process.execPath,'tests/support/messaging-crash-child.ts',schema,mode,queue,dlq],{ stdin: 'pipe',stdout: 'pipe',stderr: 'pipe' });
  try {
    const reader=child.stdout.getReader(); let line='';
    while (!line.includes('\n')) { const chunk=await reader.read(); if (chunk.done) throw new Error(await new Response(child.stderr).text()); line+=new TextDecoder().decode(chunk.value); }
    child.kill('SIGKILL'); await child.exited; return line.trim();
  } finally { if (child.exitCode===null) { child.kill('SIGKILL'); await child.exited; } }
}

test('consumer confirms inbox and finance together, then acks without duplicate debit',() => fixture(async f => {
  const w=await open(f.orm); const message=envelope(w); await send(f.client,f.source,message);
  expect(await f.consumer().pollOnce()).toBe('acked');
  await send(f.client,f.source,message); expect(await f.consumer().pollOnce()).toBe('acked');
  expect(await count(f.orm,f.s,'inbox_messages')).toBe(1); expect(await count(f.orm,f.s,'wallet_ledger')).toBe(2);
  expect(await count(f.orm,f.s,'outbox_messages')).toBe(4);
  const inboxRows=await f.orm.em.getConnection().execute<{ processed_at: Date | null }[]>(`select processed_at from ${f.s}.inbox_messages`);
  expect(inboxRows.every(row => row.processed_at!==null)).toBe(true);
  await assertBalance(f.orm,f.s,w.id,'75.00');
  expect(await drain(f.client,f.source)).toHaveLength(0);
}),15000);
test('concurrent consumers dedup logical message even in different FIFO groups',() => fixture(async f => {
  const w=await open(f.orm); const message=envelope(w);
  await send(f.client,f.source,message,'group-a'); await send(f.client,f.source,message,'group-b');
  expect(await Promise.all([f.consumer().pollOnce(),f.consumer().pollOnce()])).toEqual(['acked','acked']);
  expect(await count(f.orm,f.s,'inbox_messages')).toBe(1); expect(await count(f.orm,f.s,'wallet_ledger')).toBe(2);
  await assertBalance(f.orm,f.s,w.id,'75.00');
}),15000);
test('transport hash detects same messageId with changed key although business hash is unchanged',() => fixture(async f => {
  const w=await open(f.orm); const original=envelope(w); const changed=structuredClone(original); changed.data.idempotencyKey=randomUUID();
  expect(prepareSqsWagerRequest(original).command.payloadHash).toBe(prepareSqsWagerRequest(changed).command.payloadHash);
  expect(prepareSqsWagerRequest(original).transportHash).not.toBe(prepareSqsWagerRequest(changed).transportHash);
  await send(f.client,f.source,original); await f.consumer().pollOnce();
  await send(f.client,f.source,changed); expect(await f.consumer().pollOnce()).toBe('dlq');
  expect(await drain(f.client,f.dlq)).toHaveLength(1); expect(await count(f.orm,f.s,'inbox_messages')).toBe(1);
  await assertBalance(f.orm,f.s,w.id,'75.00');
}),15000);
test('failure before commit rolls back inbox too, retries and reaches DLQ at configured limit',() => fixture(async f => {
  const w=await open(f.orm); const real=new MikroFinancialUnitOfWork(f.orm);
  const failing: FinancialUnitOfWork={ run: work => real.run(async session => { await work(session); throw new Error('INJECTED_FAILURE'); }) };
  const processor=new ProcessWagerTransaction(failing,{ now: () => new Date(),newId: randomUUID });
  await send(f.client,f.source,envelope(w)); const consumer=f.consumer(processor,{ maxReceives: 2 });
  expect(await consumer.pollOnce()).toBe('retry'); expect(await count(f.orm,f.s,'inbox_messages')).toBe(0);
  let result=await consumer.pollOnce(); if (result==='empty') result=await consumer.pollOnce();
  expect(result).toBe('dlq'); expect(await drain(f.client,f.dlq)).toHaveLength(1);
  expect(await count(f.orm,f.s,'outbox_messages')).toBe(2); await assertBalance(f.orm,f.s,w.id,'100.00');
}),15000);
test('business rejection commits audit/inbox and is acked rather than retried',() => fixture(async f => {
  const w=await open(f.orm); await send(f.client,f.source,envelope(w,'BET','101.00'));
  expect(await f.consumer().pollOnce()).toBe('acked'); expect(await count(f.orm,f.s,'inbox_messages')).toBe(1);
  expect(await count(f.orm,f.s,'wallet_ledger')).toBe(1); expect(await drain(f.client,f.dlq)).toHaveLength(0);
  await assertBalance(f.orm,f.s,w.id,'100.00');
}),15000);
test('invalid JSON goes to DLQ before source ack',() => fixture(async f => {
  await send(f.client,f.source,'invalid-json'); expect(await f.consumer().pollOnce()).toBe('dlq');
  const dead=await drain(f.client,f.dlq); expect(dead).toHaveLength(1); expect(dead[0]?.Body).toBe('invalid-json'); expect(dead[0]?.MessageAttributes?.failureCode?.StringValue).toBe('INVALID_JSON');
  expect(await count(f.orm,f.s,'inbox_messages')).toBe(0); expect(await drain(f.client,f.source)).toHaveLength(0);
}),15000);
test('SIGKILL after SQL commit before ack redelivers without another effect',() => fixture(async f => {
  const w=await open(f.orm); await send(f.client,f.source,envelope(w));
  expect(await crashChild(f.schema,'consumer',f.source,f.dlq)).toBe('COMMITTED');
  const consumer=f.consumer(); let outcome=await consumer.pollOnce();
  for (let i=0;i<2 && outcome==='empty';i++) outcome=await consumer.pollOnce();
  expect(outcome).toBe('acked'); expect(await count(f.orm,f.s,'inbox_messages')).toBe(1);
  expect(await count(f.orm,f.s,'wallet_ledger')).toBe(2); expect(await count(f.orm,f.s,'outbox_messages')).toBe(4);
  await assertBalance(f.orm,f.s,w.id,'75.00');
}),20000);
test('two publishers claim the same outbox without losing events',() => fixture(async f => {
  const w=await open(f.orm); const published=await Promise.all([f.publisher().publishBatch(),f.publisher().publishBatch()]);
  expect(published.reduce((sum,n) => sum+n,0)).toBe(2);
  const events=await drain(f.client,f.events); expect(events).toHaveLength(2);
  expect(new Set(events.map(event => JSON.parse(event.Body!).eventId)).size).toBe(2);
  await assertBalance(f.orm,f.s,w.id,'100.00');
}),15000);
test('stale lease token cannot mark work reclaimed by another publisher',() => fixture(async f => {
  await open(f.orm); const store=new OutboxStore(f.orm); const original=(await store.claim(1))[0]!;
  await f.orm.em.getConnection().execute(`update ${f.s}.outbox_messages set lease_until=clock_timestamp()-interval '1 second' where id=?`,[original.id]);
  const replacement=(await store.claim(10)).find(claim => claim.id===original.id)!;
  expect(replacement.token).not.toBe(original.token); expect(await store.published(original)).toBe(false);
  expect(await store.published(replacement)).toBe(true);
}),15000);
test('publication error persists retry/backoff and later publisher recovers',() => fixture(async f => {
  await open(f.orm); const broken=localSqsClient();
  broken.middlewareStack.add((next,ctx) => async args => {
    if (ctx.commandName==='SendMessageCommand') throw new Error('INJECTED_SEND_FAILURE'); return next(args);
  },{ step: 'initialize',name: 'injectSendFailure' });
  try {
    expect(await f.publisher(broken).publishBatch()).toBe(0);
    const rows=await f.orm.em.getConnection().execute<{ attempts: number; next_attempt_at: Date | null; lease_token: string | null }[]>(`select attempts,next_attempt_at,lease_token from ${f.s}.outbox_messages`);
    expect(rows.every(row => row.attempts===1 && row.next_attempt_at!==null && row.lease_token===null)).toBe(true);
    expect(await f.publisher().publishBatch()).toBe(0);
    await f.orm.em.getConnection().execute(`update ${f.s}.outbox_messages set next_attempt_at=clock_timestamp()-interval '1 second'`);
    expect(await f.publisher().publishBatch()).toBe(2); expect(await drain(f.client,f.events)).toHaveLength(2);
  } finally { broken.destroy(); }
}),15000);
test('SIGKILL after send before mark recovers stable eventId; downstream inbox dedups duplicate',() => fixture(async f => {
  await open(f.orm); const marker=await crashChild(f.schema,'publisher',f.events,f.dlq);
  expect(marker.startsWith('PUBLISHED:')).toBe(true); const id=marker.slice('PUBLISHED:'.length);
  await f.orm.em.getConnection().execute(`update ${f.s}.outbox_messages set lease_until=clock_timestamp()-interval '1 second' where id=?`,[id]);
  expect(await f.publisher().publishBatch()).toBe(2);
  const events=await drain(f.client,f.events); expect(events).toHaveLength(3);
  expect(events.filter(event => JSON.parse(event.Body!).eventId===id)).toHaveLength(2);
  for (const event of events) {
    const eventId=JSON.parse(event.Body!).eventId as string;
    await f.orm.em.getConnection().execute(`insert into ${f.s}.inbox_messages values ('downstream-test',?,?,now(),now()) on conflict do nothing`,
      [eventId,createHash('sha256').update(event.Body!).digest('hex')]);
  }
  expect(await count(f.orm,f.s,'inbox_messages')).toBe(2);
},false),20000);
test('consumer deadline returns visibility without ack, then another consumer safely dedups',() => fixture(async f => {
  const w=await open(f.orm); await send(f.client,f.source,envelope(w)); let reached!: () => void; let release!: () => void;
  const committed=new Promise<void>(resolve => { reached=resolve; }); const gate=new Promise<void>(resolve => { release=resolve; });
  const first=f.consumer(undefined,{ afterCommit: async () => { reached(); await gate; } }); const task=first.pollOnce();
  try {
    await committed; await first.stop(0); expect(await f.consumer().pollOnce()).toBe('acked');
  } finally { release(); await task; }
  expect(await count(f.orm,f.s,'wallet_ledger')).toBe(2); await assertBalance(f.orm,f.s,w.id,'75.00');
}),15000);

test('new delivery identity replays the same financial command and commits its own inbox row',() => fixture(async f => {
  const w=await open(f.orm); const first=envelope(w); const second=structuredClone(first); second.messageId=randomUUID();
  await send(f.client,f.source,first); await f.consumer().pollOnce();
  await send(f.client,f.source,second); expect(await f.consumer().pollOnce()).toBe('acked');
  expect(await count(f.orm,f.s,'inbox_messages')).toBe(2); expect(await count(f.orm,f.s,'wallet_ledger')).toBe(2);
  await assertBalance(f.orm,f.s,w.id,'75.00');
}),15000);
test('failed DLQ publication never deletes the source message',() => fixture(async f => {
  await send(f.client,f.source,'invalid-json'); const broken=localSqsClient();
  broken.middlewareStack.add((next,ctx) => async args => {
    if (ctx.commandName==='SendMessageCommand') throw new Error('DLQ_UNAVAILABLE'); return next(args);
  },{ step: 'initialize',name: 'failDlqSend' });
  try {
    const consumer=new SqsWagerConsumer(broken,financialServices(f.orm).process,{ queueUrl: f.source,dlqUrl: f.dlq,visibilitySeconds: 1 });
    await expect(consumer.pollOnce()).rejects.toThrow('DLQ_UNAVAILABLE');
    const messages=await drain(f.client,f.source,2); expect(messages).toHaveLength(1); expect(messages[0]?.Body).toBe('invalid-json');
  } finally { broken.destroy(); }
}),15000);
test('graceful consumer stop drains a committed delivery and acknowledges it',() => fixture(async f => {
  const w=await open(f.orm); await send(f.client,f.source,envelope(w)); let reached!: () => void; let release!: () => void;
  const committed=new Promise<void>(resolve => { reached=resolve; }); const gate=new Promise<void>(resolve => { release=resolve; });
  const consumer=f.consumer(undefined,{ afterCommit: async () => { reached(); await gate; } });
  const task=consumer.pollOnce();
  try {
    await committed; const stopped=consumer.stop(5000); release(); expect(await task).toBe('acked'); await stopped;
    expect(await drain(f.client,f.source)).toHaveLength(0);
  } finally { release(); await task; }
  await assertBalance(f.orm,f.s,w.id,'75.00');
}),15000);
test('publisher stop releases ownership and stale publisher cannot mark reclaimed events',() => fixture(async f => {
  await open(f.orm); let reached!: () => void; let release!: () => void;
  const sent=new Promise<void>(resolve => { reached=resolve; }); const gate=new Promise<void>(resolve => { release=resolve; });
  const first=f.publisher(undefined,{ afterPublish: async () => { reached(); await gate; } }); const task=first.publishBatch();
  try {
    await sent; await first.stop(0); expect(await f.publisher().publishBatch()).toBe(2);
  } finally { release(); expect(await task).toBe(0); }
}),15000);

test('pending reference is durably acked and resumed after the referenced BET arrives',() => fixture(async f => {
  const w=await open(f.orm); const bet=envelope(w);
  const pendingBase=envelope(w,'REFUND');
  const pending={ ...pendingBase,data: { ...pendingBase.data,referenceExternalTransactionId: bet.data.externalTransactionId } };
  await send(f.client,f.source,pending); expect(await f.consumer().pollOnce()).toBe('acked');
  expect(await count(f.orm,f.s,'inbox_messages')).toBe(1); expect(await count(f.orm,f.s,'wallet_ledger')).toBe(1);
  await send(f.client,f.source,bet); expect(await f.consumer().pollOnce()).toBe('acked');
  const [record]=await f.orm.em.getConnection().execute<{ id: string }[]>(`select id from ${f.s}.wager_transactions where idempotency_key=?`,[pending.data.idempotencyKey]);
  const result=await financialServices(f.orm).process.resume(record!.id);
  expect(result.status).toBe(Status.Processed);
  expect(await count(f.orm,f.s,'inbox_messages')).toBe(2); await assertBalance(f.orm,f.s,w.id,'100.00');
}),15000);

test('consumer and publisher expose duplicate, DLQ and publication counters with safe log identifiers',() => fixture(async f => {
  const logs: string[]=[]; const telemetry=new PrometheusTelemetry(line => logs.push(line));
  const services=financialServices(f.orm,undefined,telemetry);
  const w=await services.openWallet.execute({ playerId: randomUUID(),initialBalance: { amount: '100.00',currency: 'BRL' } });
  const message=envelope(w); const consumer=f.consumer(services.process,{ telemetry });
  await send(f.client,f.source,message); await consumer.pollOnce(); await send(f.client,f.source,message); await consumer.pollOnce();
  await send(f.client,f.source,'invalid-json'); await consumer.pollOnce();
  expect(await f.publisher(undefined,{ telemetry }).publishBatch()).toBe(4);
  const text=telemetry.render();
  expect(text).toContain('wager_duplicates_total{layer="inbox"} 1');
  expect(text).toContain('wager_dlq_messages_total{reason="permanent"} 1');
  expect(text).toContain('wager_outbox_published_total 4');
  const ack=logs.map(line => JSON.parse(line)).find(row => row.event==='message_acked');
  expect(ack).toMatchObject({ messageId: message.messageId,correlationId: message.messageId,walletId: w.id,providerId: 'provider-a' });
  expect(logs.join('')).not.toContain('25.00'); await assertBalance(f.orm,f.s,w.id,'75.00');
}),15000);
