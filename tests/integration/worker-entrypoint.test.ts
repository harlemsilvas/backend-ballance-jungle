import { expect,test } from 'bun:test';
import { randomUUID,randomBytes } from 'node:crypto';
import { CreateQueueCommand,DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { withFinancialSchema } from '../support/financial-fixture';
import { financialServices } from '../../src/infrastructure/persistence/financial-services';
import { runtimeGrantSql } from '../../src/infrastructure/persistence/runtime-grants';
import { localSqsClient,localQueueUrl } from '../../src/infrastructure/messaging/local-sqs';

test('actual scheduler entrypoint runs under restricted login, exposes metrics and exits on SIGTERM',() => withFinancialSchema(async (orm,schema,s) => {
  const role=`bb_role_${randomUUID().replaceAll('-','')}`; const password=randomBytes(32).toString('hex');
  const client=localSqsClient(); const queueName=`bb-test-${randomUUID()}-metrics.fifo`; let queue: string | undefined;
  const portProbe=Bun.serve({ hostname: '127.0.0.1',port: 0,fetch: () => new Response('probe') });
  const port=portProbe.port; portProbe.stop(true);
  let child: ReturnType<typeof Bun.spawn> | undefined; let created=false;
  try {
    // Password is bound privately and no raw driver exception from this setup is propagated.
    try {
      await orm.em.fork().transactional(async em => {
        await em.execute("select set_config('ballance_test.password',?,true)",[password]);
        await em.execute(`do $$ begin execute format('create role %I login password %L','${role}',current_setting('ballance_test.password')); end $$`);
      }); created=true;
    } catch { throw new Error('TEST_LOGIN_SETUP_FAILED'); }
    for (const sql of runtimeGrantSql(schema,role)) await orm.em.getConnection().execute(sql);
    await orm.em.getConnection().execute(`do $$ begin execute format('grant connect on database %I to %I',current_database(),'${role}'); end $$`);
    await client.send(new CreateQueueCommand({ QueueName: queueName,Attributes: { FifoQueue: 'true' } })); queue=await localQueueUrl(client,queueName);
    const service=financialServices(orm); const wallet=await service.openWallet.execute({ playerId: randomUUID(),initialBalance: { amount: '100.00',currency: 'BRL' } });
    const bet={ providerId: 'provider-a',externalTransactionId: randomUUID(),playerId: wallet.playerId,walletId: wallet.id,
      roundId: 'round',gameId: 'game',kind: 'BET',money: { amount: '25.00',currency: 'BRL' } };
    const pending=await service.process.execute({ ...bet,kind: 'REFUND',externalTransactionId: randomUUID(),referenceExternalTransactionId: bet.externalTransactionId },randomUUID());
    await service.process.execute(bet,randomUUID());
    await orm.em.getConnection().execute(`update ${s}.wager_transactions set next_reference_attempt_at=clock_timestamp()-interval '1 second' where id=?`,[pending.transactionId]);
    child=Bun.spawn([process.execPath,'src/bootstrap/workers.ts'],{ stdin: 'ignore',stdout: 'pipe',stderr: 'pipe',env: {
      ...process.env,DB_SCHEMA: schema,DB_USER: role,DB_PASSWORD: password,WORKER_MODE: 'scheduler',WORKER_METRICS_PORT: String(port),WAGER_DLQ_NAME: queueName,
    } });
    const output=child.stdout;
    if (!output || typeof output==='number') throw new Error('WORKER_STDOUT_REQUIRED');
    const reader=output.getReader(); let seen=false; let buffer=''; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([(async () => {
        while (!seen) {
          const chunk=await reader.read(); if (chunk.done) throw new Error('WORKER_EXITED_BEFORE_PROCESSING'); buffer+=new TextDecoder().decode(chunk.value);
          let position: number;
          while ((position=buffer.indexOf('\n'))>=0) {
            const line=buffer.slice(0,position); buffer=buffer.slice(position+1);
            if (line && JSON.parse(line).event==='reference_completed') { seen=true; break; }
          }
        }
      })(),new Promise<never>((_resolve,reject) => { timer=setTimeout(() => reject(new Error('WORKER_PROCESSING_TIMEOUT')),10000); })]);
    } finally { if (timer) clearTimeout(timer); }
    expect(seen).toBe(true);
    const url=`http://127.0.0.1:${port}`;
    expect((await fetch(url+'/health/live')).status).toBe(200); expect((await fetch(url+'/health/ready')).status).toBe(200);
    const metrics=await (await fetch(url+'/metrics')).text();
    expect(metrics).toContain('wager_reference_claims_total{outcome="completed"} 1');
    expect(metrics).toContain('wager_transactions_stored{status="PROCESSED"} 3');
    expect(metrics).not.toContain(role); expect(metrics).not.toContain(password);
    const processChild=child; processChild.kill('SIGTERM');
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([processChild.exited,new Promise<never>((_resolve,reject) => { stopTimer=setTimeout(() => reject(new Error('WORKER_SIGTERM_TIMEOUT')),10000); })])).toBe(0);
    } finally { if (stopTimer) clearTimeout(stopTimer); }
    const [row]=await orm.em.getConnection().execute<{ balance: string; calculated: string }[]>(`select w.balance::numeric(20,2)::text as balance,
      sum(case direction when 'CREDIT' then amount else -amount end)::numeric(20,2)::text as calculated
      from ${s}.wallets w join ${s}.wallet_ledger l on l.wallet_id=w.id where w.id=? group by w.id`,[wallet.id]);
    expect(row?.balance).toBe('100.00'); expect(row?.calculated).toBe('100.00');
  } finally {
    if (child && child.exitCode===null) { child.kill('SIGKILL'); await child.exited; }
    if (queue) await client.send(new DeleteQueueCommand({ QueueUrl: queue })); client.destroy();
    if (created) {
      await orm.em.getConnection().execute(`revoke all on all tables in schema ${s} from "${role}"`);
      await orm.em.getConnection().execute(`revoke all on all functions in schema ${s} from "${role}"`);
      await orm.em.getConnection().execute(`revoke all on schema ${s} from "${role}"`);
      await orm.em.getConnection().execute(`do $$ begin execute format('revoke connect on database %I from %I',current_database(),'${role}'); end $$`);
      await orm.em.getConnection().execute(`drop role "${role}"`);
    }
  }
}),30000);
