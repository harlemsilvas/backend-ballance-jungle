import { WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { expect,test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { withFinancialSchema } from '../support/financial-fixture';
import { financialServices } from '../../src/infrastructure/persistence/financial-services';
import { ReferenceStore } from '../../src/infrastructure/persistence/reference-store';
import { ReferenceScheduler } from '../../src/infrastructure/messaging/reference-scheduler';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/mikro-financial-unit-of-work';
import { ProcessWagerTransaction } from '../../src/application/financial-use-cases';
import { PrometheusTelemetry } from '../../src/infrastructure/observability/telemetry';
import type { FinancialUnitOfWork } from '../../src/application/financial-ports';

async function pending(orm: MikroORM,age=0) {
  const at=new Date(Date.now()-age); const service=financialServices(orm,{ now: () => new Date(at),newId: randomUUID,random: () => 0 });
  const wallet=await service.openWallet.execute({ playerId: randomUUID(),initialBalance: { amount: '100.00',currency: 'BRL' } });
  const bet={ providerId: 'provider-a',externalTransactionId: randomUUID(),playerId: wallet.playerId,walletId: wallet.id,
    roundId: 'round',gameId: 'game',kind: 'BET',money: { amount: '25.00',currency: 'BRL' } };
  const refund={ ...bet,externalTransactionId: randomUUID(),kind: 'REFUND',referenceExternalTransactionId: bet.externalTransactionId };
  const key=randomUUID(); const result=await service.process.execute(refund,key); return { wallet,bet,refund,key,result };
}
const due=(orm: MikroORM,s: string,id: string) => orm.em.getConnection().execute(`update ${s}.wager_transactions set next_reference_attempt_at=clock_timestamp()-interval '1 second' where id=?`,[id]);
async function balance(orm: MikroORM,s: string,id: string,amount: string) {
  const [row]=await orm.em.getConnection().execute<{ balance: string; calculated: string }[]>(`select w.balance::numeric(20,2)::text as balance,
    coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end),0)::numeric(20,2)::text as calculated
    from ${s}.wallets w left join ${s}.wallet_ledger l on l.wallet_id=w.id where w.id=? group by w.id`,[id]);
  expect(row?.balance).toBe(amount); expect(row?.calculated).toBe(amount);
}
test('reference_jobs migration is reversible independently of financial history',() => withFinancialSchema(async (orm,schema) => {
  expect(await orm.getMigrator().getExecutedMigrations()).toHaveLength(3);
  await orm.getMigrator().down();
  const [row]=await orm.em.getConnection().execute<{ name: string | null }[]>('select to_regclass(?) as name',[schema+'.reference_jobs']);
  expect(row?.name).toBeNull(); await orm.getMigrator().up(); expect(await orm.getMigrator().getExecutedMigrations()).toHaveLength(3);
}));
test('scheduler skips future attempts and discovers pending jobs durably',() => withFinancialSchema(async (orm,_schema,s) => {
  const item=await pending(orm); await orm.em.getConnection().execute(`update ${s}.wager_transactions set next_reference_attempt_at=clock_timestamp()+interval '1 hour' where id=?`,[item.result.transactionId]);
  expect(await new ReferenceScheduler(new ReferenceStore(orm),financialServices(orm).process).tick()).toBe(0);
  const rows=await orm.em.getConnection().execute(`select * from ${s}.reference_jobs where transaction_id=?`,[item.result.transactionId]);
  expect(rows).toHaveLength(1); await balance(orm,s,item.wallet.id,'100.00');
}));
test('automatic scheduler completes due refund when reference arrives',() => withFinancialSchema(async (orm,_schema,s) => {
  const item=await pending(orm); await financialServices(orm).process.execute(item.bet,randomUUID()); await due(orm,s,item.result.transactionId);
  const telemetry=new PrometheusTelemetry(() => {});
  expect(await new ReferenceScheduler(new ReferenceStore(orm),financialServices(orm).process,{ telemetry }).tick()).toBe(1);
  const replay=await financialServices(orm).process.execute(item.refund,item.key); expect(replay.status).toBe(WagerTransactionStatus.Processed);
  expect(telemetry.render()).toContain('wager_reference_claims_total{outcome="completed"} 1');
  const [job]=await orm.em.getConnection().execute<{ lease_token: string | null }[]>(`select lease_token from ${s}.reference_jobs where transaction_id=?`,[item.result.transactionId]);
  expect(job?.lease_token).toBeNull(); await balance(orm,s,item.wallet.id,'100.00');
}));
test('two schedulers cannot apply the same pending operation twice',() => withFinancialSchema(async (orm,_schema,s) => {
  const item=await pending(orm); await financialServices(orm).process.execute(item.bet,randomUUID()); await due(orm,s,item.result.transactionId);
  const results=await Promise.all([1,2].map(() => new ReferenceScheduler(new ReferenceStore(orm),financialServices(orm).process).tick()));
  expect(results.reduce((sum,n) => sum+n,0)).toBe(1);
  const [row]=await orm.em.getConnection().execute<{ n: number }[]>(`select count(*)::int as n from ${s}.wallet_ledger where wallet_id=?`,[item.wallet.id]);
  expect(row?.n).toBe(3); await balance(orm,s,item.wallet.id,'100.00');
}));
test('SIGKILL after claim recovers after lease expiration without losing the pending transaction',() => withFinancialSchema(async (orm,schema,s) => {
  const item=await pending(orm); await financialServices(orm).process.execute(item.bet,randomUUID()); await due(orm,s,item.result.transactionId);
  const child=Bun.spawn([process.execPath,'tests/support/reference-crash-child.ts',schema],{ stdin: 'pipe',stdout: 'pipe',stderr: 'pipe' });
  try {
    const reader=child.stdout.getReader(); let text=''; while (!text.includes('\n')) { const chunk=await reader.read(); if (chunk.done) throw new Error(await new Response(child.stderr).text()); text+=new TextDecoder().decode(chunk.value); }
    expect(text.trim()).toBe('CLAIMED'); child.kill('SIGKILL'); await child.exited;
    expect(await new ReferenceScheduler(new ReferenceStore(orm),financialServices(orm).process).tick()).toBe(0);
    await orm.em.getConnection().execute(`update ${s}.reference_jobs set lease_until=clock_timestamp()-interval '1 second'`);
    expect(await new ReferenceScheduler(new ReferenceStore(orm),financialServices(orm).process).tick()).toBe(1);
    await balance(orm,s,item.wallet.id,'100.00');
  } finally { if (child.exitCode===null) { child.kill('SIGKILL'); await child.exited; } }
}),15000);
test('stale scheduler claim is rejected after another owner takes over',() => withFinancialSchema(async (orm,_schema,s) => {
  const item=await pending(orm); await financialServices(orm).process.execute(item.bet,randomUUID()); await due(orm,s,item.result.transactionId);
  const store=new ReferenceStore(orm); const old=(await store.claim())[0]!;
  await orm.em.getConnection().execute(`update ${s}.reference_jobs set lease_until=clock_timestamp()-interval '1 second'`);
  const current=(await store.claim())[0]!;
  await expect(financialServices(orm).process.resume(item.result.transactionId,{},old)).rejects.toThrow('REFERENCE_CLAIM_LOST');
  await financialServices(orm).process.resume(item.result.transactionId,{},current); await balance(orm,s,item.wallet.id,'100.00');
}));
test('TTL expires automatically and future retry schedule does not postpone expiry',() => withFinancialSchema(async (orm,_schema,s) => {
  const item=await pending(orm,25*60*60*1000);
  await orm.em.getConnection().execute(`update ${s}.wager_transactions set next_reference_attempt_at=clock_timestamp()+interval '1 hour' where id=?`,[item.result.transactionId]);
  expect(await new ReferenceScheduler(new ReferenceStore(orm),financialServices(orm).process).tick()).toBe(1);
  const result=await financialServices(orm).process.execute(item.refund,item.key); expect(result.failureCode).toBe('REFERENCE_EXPIRED');
  await balance(orm,s,item.wallet.id,'100.00');
}));
test('failed resume rolls back and keeps the reference claim recoverable with backoff',() => withFinancialSchema(async (orm,_schema,s) => {
  const item=await pending(orm); await financialServices(orm).process.execute(item.bet,randomUUID()); await due(orm,s,item.result.transactionId);
  const real=new MikroFinancialUnitOfWork(orm);
  const failing: FinancialUnitOfWork={ run: work => real.run(async session => { await work(session); throw new Error('INJECTED_FAILURE'); }) };
  const process=new ProcessWagerTransaction(failing,{ now: () => new Date(),newId: randomUUID }); const store=new ReferenceStore(orm);
  expect(await new ReferenceScheduler(store,process).tick()).toBe(0); await balance(orm,s,item.wallet.id,'75.00');
  expect(await new ReferenceScheduler(store,financialServices(orm).process).tick()).toBe(0);
  await orm.em.getConnection().execute(`update ${s}.reference_jobs set lease_until=clock_timestamp()-interval '1 second'`);
  expect(await new ReferenceScheduler(store,financialServices(orm).process).tick()).toBe(1); await balance(orm,s,item.wallet.id,'100.00');
}));
test('stop after claim returns ownership and late scheduler cannot apply it',() => withFinancialSchema(async (orm,_schema,s) => {
  const item=await pending(orm); await financialServices(orm).process.execute(item.bet,randomUUID()); await due(orm,s,item.result.transactionId);
  let reached!: () => void; let release!: () => void; const claimed=new Promise<void>(resolve => { reached=resolve; }); const gate=new Promise<void>(resolve => { release=resolve; });
  const telemetry=new PrometheusTelemetry(() => {});
  const first=new ReferenceScheduler(new ReferenceStore(orm),financialServices(orm).process,{ telemetry,afterClaim: async () => { reached(); await gate; } });
  const task=first.tick();
  try { await claimed; await first.stop(0); expect(await new ReferenceScheduler(new ReferenceStore(orm),financialServices(orm).process).tick()).toBe(1); }
  finally { release(); expect(await task).toBe(0); }
  expect(telemetry.render()).toContain('wager_reference_claims_total{outcome="released"} 1');
  await balance(orm,s,item.wallet.id,'100.00');
}));
test('claim does not acquire a wallet lock or invert financial lock order',() => withFinancialSchema(async (orm,_schema,s) => {
  const item=await pending(orm); await due(orm,s,item.result.transactionId);
  let reached!: () => void; let release!: () => void; const ready=new Promise<void>(resolve => { reached=resolve; }); const gate=new Promise<void>(resolve => { release=resolve; });
  const holding=new MikroFinancialUnitOfWork(orm).run(async session => { await session.lockWallet(item.wallet.id); reached(); await gate; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await ready;
    const claims=await Promise.race([new ReferenceStore(orm).claim(),new Promise<never>((_resolve,reject) => { timer=setTimeout(() => reject(new Error('CLAIM_BLOCKED_ON_WALLET')),1500); })]);
    expect(claims).toHaveLength(1);
  } finally { if (timer) clearTimeout(timer); release(); await holding; }
  await balance(orm,s,item.wallet.id,'100.00');
}));
