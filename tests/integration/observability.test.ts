import { expect,test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateQueueCommand,DeleteQueueCommand,SendMessageCommand } from '@aws-sdk/client-sqs';
import { withFinancialSchema } from '../support/financial-fixture';
import { financialServices } from '../../src/infrastructure/persistence/financial-services';
import { PrometheusTelemetry } from '../../src/infrastructure/observability/telemetry';
import { MetricsCollector } from '../../src/infrastructure/observability/metrics-collector';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/mikro-financial-unit-of-work';
import { localSqsClient,localQueueUrl } from '../../src/infrastructure/messaging/local-sqs';
import { createFinancialHttpApp } from '../../src/interfaces/http/financial-http';
import { createWorkerObservability } from '../../src/interfaces/http/worker-observability';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

async function activity(orm: MikroORM,telemetry: PrometheusTelemetry) {
  const services=financialServices(orm,undefined,telemetry);
  const w=await services.openWallet.execute({ playerId: randomUUID(),initialBalance: { amount: '100.00',currency: 'BRL' } });
  const body={ providerId: 'provider-a',externalTransactionId: randomUUID(),walletId: w.id,playerId: w.playerId,
    roundId: 'round',gameId: 'game',kind: 'BET',money: { amount: '25.00',currency: 'BRL' } };
  const key=randomUUID();
  const result=await services.process.execute(body,key,{ correlationId: 'test-corr' });
  await services.process.execute(body,key,{ correlationId: 'test-corr' });
  await services.process.execute({ ...body,externalTransactionId: randomUUID(),money: { amount: '101.00',currency: 'BRL' } },randomUUID());
  return { w,result };
}
test('committed outcomes, duplicates, latency and correlation are emitted without financial payload',() => withFinancialSchema(async orm => {
  const lines: string[]=[]; const telemetry=new PrometheusTelemetry(line => lines.push(line)); const { w,result }=await activity(orm,telemetry);
  const text=telemetry.render();
  expect(text).toContain('wager_transactions_total{status="PROCESSED"} 2');
  expect(text).toContain('wager_transactions_total{status="REJECTED"} 1');
  expect(text).toContain('wager_duplicates_total{layer="financial"} 1');
  expect(text).toContain('wager_processing_duration_seconds_count{operation="process"} 3');
  const committed=lines.map(line => JSON.parse(line)).find(row => row.transactionId===result.transactionId);
  expect(committed).toMatchObject({ correlationId: 'test-corr',walletId: w.id,providerId: 'provider-a',messageId: null,status: 'PROCESSED' });
  expect(lines.join('')).not.toContain('25.00'); expect(lines.join('')).not.toContain('balance');
}));
test('database metrics recover stored status and outbox backlog after registry restart',() => withFinancialSchema(async (orm,_schema,s) => {
  await activity(orm,new PrometheusTelemetry(() => {})); const telemetry=new PrometheusTelemetry(() => {});
  const client=localSqsClient(); const name=`bb-test-${randomUUID()}-metrics.fifo`; let url: string | undefined;
  try {
    await client.send(new CreateQueueCommand({ QueueName: name,Attributes: { FifoQueue: 'true' } })); url=await localQueueUrl(client,name);
    await client.send(new SendMessageCommand({ QueueUrl: url,MessageBody: 'metrics-probe',MessageGroupId: 'metrics',MessageDeduplicationId: randomUUID() }));
    const text=await new MetricsCollector(orm,telemetry,client,name).scrape();
    expect(text).toContain('wager_transactions_total{status="PROCESSED"} 0');
    expect(text).toContain('wager_transactions_stored{status="PROCESSED"} 2');
    expect(text).toContain('wager_transactions_stored{status="REJECTED"} 1');
    expect(text).toContain('wager_outbox_pending 5'); expect(text).toContain('wager_dlq_visible_messages 1');
    expect(text).toContain('wager_metrics_collection_success{source="database"} 1');
    expect(text).toContain('wager_metrics_collection_success{source="sqs"} 1');
    expect(Number(text.match(/^wager_outbox_lag_seconds ([0-9.e+-]+)/m)?.[1])).toBeGreaterThanOrEqual(0);
    const [row]=await orm.em.getConnection().execute<{ n: number }[]>(`select count(*)::int as n from ${s}.outbox_messages`); expect(row?.n).toBe(5);
  } finally { if (url) await client.send(new DeleteQueueCommand({ QueueUrl: url })); client.destroy(); }
}));
test('collection failure preserves last values and signals source failure',() => withFinancialSchema(async orm => {
  const telemetry=new PrometheusTelemetry(() => {}); await activity(orm,telemetry); const client=localSqsClient(); const broken=localSqsClient();
  const name=`bb-test-${randomUUID()}-metrics.fifo`; let url: string | undefined;
  const badOrm=await MikroORM.init({ ...persistenceConfig(),schema: `bb_missing_${randomUUID().replaceAll('-','')}` });
  try {
    await client.send(new CreateQueueCommand({ QueueName: name,Attributes: { FifoQueue: 'true' } })); url=await localQueueUrl(client,name);
    await new MetricsCollector(orm,telemetry,client,name).scrape();
    broken.middlewareStack.add(() => async () => { throw new Error('SQS_DOWN'); },{ step: 'initialize',name: 'failMetrics' });
    const text=await new MetricsCollector(badOrm,telemetry,broken,name).scrape();
    expect(text).toContain('wager_outbox_pending 5');
    expect(text).toContain('wager_metrics_collection_success{source="database"} 0');
    expect(text).toContain('wager_metrics_collection_success{source="sqs"} 0');
    expect(text).toContain('wager_metrics_collection_errors_total{source="database"} 1');
    expect(text).toContain('wager_metrics_collection_errors_total{source="sqs"} 1');
  } finally { if (url) await client.send(new DeleteQueueCommand({ QueueUrl: url })); client.destroy(); broken.destroy(); await badOrm.close(true); }
}));
test('actual PostgreSQL lock timeout emits conflict/retry and a later attempt succeeds',() => withFinancialSchema(async (orm,_schema,s) => {
  const w=await financialServices(orm).openWallet.execute({ playerId: randomUUID(),initialBalance: { amount: '100.00',currency: 'BRL' } });
  let reached!: () => void; let release!: () => void;
  const locked=new Promise<void>(resolve => { reached=resolve; }); const gate=new Promise<void>(resolve => { release=resolve; });
  const holder=new MikroFinancialUnitOfWork(orm).run(async session => { await session.lockWallet(w.id); reached(); await gate; });
  const logs: string[]=[]; const telemetry=new PrometheusTelemetry(line => { logs.push(line); if (JSON.parse(line).event==='database_retry') release(); });
  let timer: ReturnType<typeof setTimeout> | undefined; let task: Promise<unknown> | undefined;
  try {
    await locked; task=new MikroFinancialUnitOfWork(orm,telemetry,{ lockTimeoutMs: 50 }).run(session => session.lockWallet(w.id),{ correlationId: 'lock-corr',walletId: w.id });
    await Promise.race([task,new Promise<never>((_resolve,reject) => { timer=setTimeout(() => reject(new Error('RETRY_DID_NOT_RECOVER')),3000); })]);
    const retries=logs.map(line => JSON.parse(line)).filter(row => row.event==='database_retry').length;
    expect(telemetry.render()).toContain(`wager_lock_conflicts_total{kind="timeout"} ${Math.max(1,retries)}`);
    expect(telemetry.render()).toContain(`wager_retries_total{component="database"} ${Math.max(1,retries)}`);
    expect(logs.map(line => JSON.parse(line)).some(row => row.correlationId==='lock-corr' && row.code==='55P03')).toBe(true);
  } finally { if (timer) clearTimeout(timer); release(); await holder; await task?.catch(() => {}); }
  const [row]=await orm.em.getConnection().execute<{ balance: string }[]>(`select balance from ${s}.wallets where id=?`,[w.id]); expect(row?.balance).toBe('100.00');
}),10000);
test('API and worker endpoints expose Prometheus text and readiness',() => withFinancialSchema(async orm => {
  const telemetry=new PrometheusTelemetry(() => {}); const api=await createFinancialHttpApp(orm,{ telemetry });
  const client=localSqsClient(); const collector=new MetricsCollector(orm,telemetry,client);
  const worker=await createWorkerObservability(collector,async () => { await orm.em.getConnection().execute('select 1'); });
  try {
    await api.listen(0,'127.0.0.1'); await worker.listen(0,'127.0.0.1');
    const apiUrl=await api.getUrl(); const response=await fetch(apiUrl+'/metrics');
    expect(response.headers.get('content-type')).toContain('text/plain'); expect(await response.text()).toContain('wager_processing_duration_seconds_bucket');
    const workerUrl=await worker.getUrl(); expect((await fetch(workerUrl+'/health/ready')).status).toBe(200);
    expect(await (await fetch(workerUrl+'/metrics')).text()).toContain('wager_outbox_lag_seconds');
    expect((await fetch(workerUrl+'/health/live')).status).toBe(200);
  } finally { await api.close(); await worker.close(); client.destroy(); }
}));
