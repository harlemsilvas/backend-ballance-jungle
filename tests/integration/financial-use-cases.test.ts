import { beforeAll, afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { Migration202610260001FinancialSchema } from '../../src/infrastructure/persistence/migrations/Migration202610260001FinancialSchema';
import { Migration202610260002BalanceLimit } from '../../src/infrastructure/persistence/migrations/Migration202610260002BalanceLimit';
import { financialServices } from '../../src/infrastructure/persistence/financial-services';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/mikro-financial-unit-of-work';
import { OpenWallet, ProcessWagerTransaction } from '../../src/application/financial-use-cases';
import type { FinancialUnitOfWork, ExecutionEnvironment, TransactionResult } from '../../src/application/financial-ports';
import { WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { LedgerMapper } from '../../src/infrastructure/persistence/financial-mappers';
import { WalletLedgerSchema } from '../../src/infrastructure/persistence/financial-records';

const schema = `bb_test_${randomUUID().replaceAll('-', '')}`; const s = `"${schema}"`;
let orm: MikroORM;
const env: ExecutionEnvironment = { now: () => new Date(),newId: randomUUID };
const services = () => financialServices(orm);
const opening = (amount = '100.00',playerId = randomUUID()) => ({ playerId,initialBalance: { amount,currency: 'BRL' } });
type WalletResult = Awaited<ReturnType<OpenWallet['execute']>>;
function request(w: WalletResult,overrides: Record<string,unknown> = {}) {
  return { providerId: 'provider-a',externalTransactionId: randomUUID(),playerId: w.playerId,walletId: w.id,
    roundId: 'round-1',gameId: 'game-1',kind: 'BET',money: { amount: '25.00',currency: 'BRL' }, ...overrides };
}
async function state(id: string) {
  const [row] = await orm.em.getConnection().execute<{ balance: string; version: number; calculated: string }[]>(
    `select w.balance::numeric(20,2)::text as balance,w.version,
      coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end),0)::numeric(20,2)::text as calculated
      from ${s}.wallets w left join ${s}.wallet_ledger l on l.wallet_id=w.id where w.id=? group by w.id`,[id]);
  if (!row) throw new Error('Wallet missing');
  expect(row.balance).toBe(row.calculated);
  return row;
}
async function count(table: string,walletId: string): Promise<number> {
  const field = table === 'outbox_messages' ? 'aggregate_id' : 'wallet_id';
  const [row] = await orm.em.getConnection().execute<{ count: number }[]>(`select count(*)::int as count from ${s}.${table} where ${field}=?`,[walletId]);
  return row!.count;
}
function failingUow(): FinancialUnitOfWork {
  const real = new MikroFinancialUnitOfWork(orm);
  return { run: work => real.run(async session => { await work(session); throw new Error('INJECTED_BEFORE_COMMIT'); }) };
}
beforeAll(async () => {
  const base = persistenceConfig();
  orm = await MikroORM.init({ ...base,schema,migrations: { ...base.migrations,
    migrationsList: [
      { name: 'Migration202610260001FinancialSchema',class: Migration202610260001FinancialSchema },
      { name: 'Migration202610260002BalanceLimit',class: Migration202610260002BalanceLimit },
    ],
    tableName: `${schema}.mikro_orm_migrations` } });
  await orm.em.getConnection().execute(`create schema ${s}`);
  await orm.getMigrator().up();
},30000);
afterAll(async () => {
  if (!orm) return;
  try { await orm.em.getConnection().execute(`drop schema if exists ${s} cascade`); }
  finally { await orm.close(true); }
});

test('taxonomy migration supports down/up before any financial data is inserted',async () => {
  expect(await orm.getMigrator().getExecutedMigrations()).toHaveLength(2);
  await orm.getMigrator().down();
  expect(await orm.getMigrator().getExecutedMigrations()).toHaveLength(1);
  await orm.getMigrator().up();
  expect(await orm.getMigrator().getExecutedMigrations()).toHaveLength(2);
});
test('opening positive persists OPENING, one credit and both outbox events at version 1',async () => {
  const w = await services().openWallet.execute(opening());
  expect(w.version).toBe(1); expect(w.balance.amount).toBe('100.00');
  expect(await count('wager_transactions',w.id)).toBe(1);
  expect(await count('wallet_ledger',w.id)).toBe(1);
  expect(await count('outbox_messages',w.id)).toBe(2);
  expect((await state(w.id)).balance).toBe('100.00');
  const entry = await orm.em.fork().findOneOrFail(WalletLedgerSchema,{ walletId: w.id });
  expect(LedgerMapper.fromRow(entry).isBalanced()).toBe(true);
});
test('zero opening has no transaction, ledger or balance event',async () => {
  const w = await services().openWallet.execute(opening('0.00'));
  expect(await count('wallet_ledger',w.id)).toBe(0);
  expect(await count('wager_transactions',w.id)).toBe(0);
  expect(await count('outbox_messages',w.id)).toBe(0);
  expect((await state(w.id)).version).toBe(1);
});
test('concurrent duplicate wallet creation returns one success and a stable conflict',async () => {
  const input = opening();
  const results = await Promise.allSettled([services().openWallet.execute(input),services().openWallet.execute(input)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find(r => r.status === 'rejected');
  expect(rejected?.status === 'rejected' && rejected.reason.code).toBe('WALLET_ALREADY_EXISTS');
});
test('opening failure before commit rolls back wallet, transaction, ledger and outbox',async () => {
  const input = opening();
  await expect(new OpenWallet(failingUow(),env).execute(input)).rejects.toThrow('INJECTED_BEFORE_COMMIT');
  const rows = await orm.em.getConnection().execute(`select id from ${s}.wallets where player_id=?`,[input.playerId]);
  expect(rows).toHaveLength(0);
});
test('BET response replays its historical balance after later WIN and a new service instance',async () => {
  const w = await services().openWallet.execute(opening()); const body = request(w); const key = randomUUID();
  const first = await services().process.execute(body,key);
  expect(first.balance.amount).toBe('75.00');
  await services().process.execute(request(w,{ kind: 'WIN',money: { amount: '40.00',currency: 'BRL' } }),randomUUID());
  const replay = await financialServices(orm).process.execute(body,key);
  expect(replay).toEqual({ ...first,idempotentReplay: true });
  expect((await state(w.id)).balance).toBe('115.00');
  expect(await count('wallet_ledger',w.id)).toBe(3);
});
test('key payload conflict and external identity with another key do not cause another movement',async () => {
  const w = await services().openWallet.execute(opening()); const body = request(w); const key = randomUUID();
  await services().process.execute(body,key);
  await expect(services().process.execute({ ...body,money: { amount: '24.00',currency: 'BRL' } },key)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  await expect(services().process.execute(body,randomUUID())).rejects.toThrow('EXTERNAL_TRANSACTION_CONFLICT');
  expect((await state(w.id)).balance).toBe('75.00');
});
test('insufficient funds and player mismatch persist rejection and replay without ledger',async () => {
  const w = await services().openWallet.execute(opening());
  const body = request(w,{ money: { amount: '101.00',currency: 'BRL' } }); const key = randomUUID();
  const rejected = await services().process.execute(body,key);
  expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS'); expect(rejected.status).toBe(Status.Rejected);
  await services().process.execute(request(w,{ kind: 'WIN' }),randomUUID());
  expect(await services().process.execute(body,key)).toEqual({ ...rejected,idempotentReplay: true });
  const mismatch = await services().process.execute(request(w,{ playerId: randomUUID() }),randomUUID());
  expect(mismatch.failureCode).toBe('PLAYER_MISMATCH');
  expect(await count('wallet_ledger',w.id)).toBe(2);
  expect((await state(w.id)).balance).toBe('125.00');
});
test('LOSS produces processed event without changing balance, ledger or version',async () => {
  const w = await services().openWallet.execute(opening());
  const result = await services().process.execute(request(w,{ kind: 'LOSS',money: { amount: '0.00',currency: 'BRL' } }),randomUUID());
  expect(result.status).toBe(Status.Processed);
  expect(await count('outbox_messages',w.id)).toBe(3);
  expect(await count('wallet_ledger',w.id)).toBe(1);
  expect((await state(w.id)).version).toBe(1);
});
test('failure after all financial writes rolls everything back and retry applies once',async () => {
  const w = await services().openWallet.execute(opening()); const body = request(w); const key = randomUUID();
  await expect(new ProcessWagerTransaction(failingUow(),env).execute(body,key)).rejects.toThrow('INJECTED_BEFORE_COMMIT');
  expect(await count('wager_transactions',w.id)).toBe(1);
  expect(await count('wallet_ledger',w.id)).toBe(1); expect(await count('outbox_messages',w.id)).toBe(2);
  expect((await state(w.id)).balance).toBe('100.00');
  expect((await services().process.execute(body,key)).balance.amount).toBe('75.00');
});
test('50 parallel repeats yield one debit and preserve outbox event count',async () => {
  const w = await services().openWallet.execute(opening()); const body = request(w); const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 50 },() => services().process.execute(body,key)));
  expect(new Set(results.map(r => r.transactionId)).size).toBe(1);
  expect(results.filter(r => !r.idempotentReplay)).toHaveLength(1);
  expect(await count('wallet_ledger',w.id)).toBe(2); expect(await count('outbox_messages',w.id)).toBe(4);
  expect((await state(w.id)).balance).toBe('75.00');
},30000);
test('competing BETs of 80 over 100 yield exactly one debit and one rejection',async () => {
  const w = await services().openWallet.execute(opening());
  const results = await Promise.all([1,2].map(() => services().process.execute(request(w,{ money: { amount: '80.00',currency: 'BRL' } }),randomUUID())));
  expect(results.filter(r => r.status === Status.Processed)).toHaveLength(1);
  expect(results.filter(r => r.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(1);
  expect(await count('wallet_ledger',w.id)).toBe(2); expect((await state(w.id)).balance).toBe('20.00');
});
test('same global key racing across distinct wallets resolves as conflict after rollback',async () => {
  const wallets = await Promise.all([services().openWallet.execute(opening()),services().openWallet.execute(opening())]);
  const key = randomUUID();
  const results = await Promise.allSettled(wallets.map(w => services().process.execute(request(w),key)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const failed = results.find(r => r.status === 'rejected');
  expect(failed?.status === 'rejected' && failed.reason.code).toBe('IDEMPOTENCY_CONFLICT');
  const balances = await Promise.all(wallets.map(w => state(w.id)));
  expect(balances.map(w => w.balance).sort()).toEqual(['100.00','75.00']);
});
test('refund before BET stays pending, emits once and resumes to terminal result',async () => {
  const w = await services().openWallet.execute(opening()); const external = randomUUID();
  const pendingBody = request(w,{ kind: 'REFUND',referenceExternalTransactionId: external }); const key = randomUUID();
  const pending = await services().process.execute(pendingBody,key);
  expect(pending.status).toBe(Status.PendingReference);
  await services().process.resume(pending.transactionId);
  expect(await count('outbox_messages',w.id)).toBe(3);
  await services().process.execute(request(w,{ externalTransactionId: external }),randomUUID());
  const processed = await services().process.resume(pending.transactionId);
  expect(processed.status).toBe(Status.Processed); expect(processed.balance.amount).toBe('100.00');
  expect(await services().process.execute(pendingBody,key)).toEqual({ ...processed,idempotentReplay: true });
  expect((await state(w.id)).version).toBe(3);
});
test('missing reference expires after persistent TTL without ledger',async () => {
  const w = await services().openWallet.execute(opening());
  const pending = await services().process.execute(request(w,{ kind: 'REFUND',referenceExternalTransactionId: randomUUID() }),randomUUID());
  const future = new ProcessWagerTransaction(new MikroFinancialUnitOfWork(orm),{
    ...env,now: () => new Date(Date.now() + 25 * 60 * 60 * 1000) });
  const expired = await future.resume(pending.transactionId);
  expect(expired.failureCode).toBe('REFERENCE_EXPIRED');
  expect(await count('wallet_ledger',w.id)).toBe(1); await state(w.id);
});
test('duplicate refund is rejected while rollback of WIN rejects distinctly when funds are spent',async () => {
  const w = await services().openWallet.execute(opening());
  const betBody = request(w); await services().process.execute(betBody,randomUUID());
  await services().process.execute(request(w,{ kind: 'REFUND',referenceExternalTransactionId: betBody.externalTransactionId }),randomUUID());
  const duplicate = await services().process.execute(request(w,{ kind: 'REFUND',referenceExternalTransactionId: betBody.externalTransactionId }),randomUUID());
  expect(duplicate.failureCode).toBe('REVERSAL_ALREADY_APPLIED');
  const win = request(w,{ kind: 'WIN' }); await services().process.execute(win,randomUUID());
  await services().process.execute(request(w,{ money: { amount: '125.00',currency: 'BRL' } }),randomUUID());
  const rollback = await services().process.execute(request(w,{ kind: 'ROLLBACK',referenceExternalTransactionId: win.externalTransactionId }),randomUUID());
  expect(rollback.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
  expect((await state(w.id)).balance).toBe('0.00');
});
test('unknown wallet and invalid domain contracts are not accepted or partially persisted',async () => {
  const w = await services().openWallet.execute(opening());
  await expect(services().process.execute(request(w,{ walletId: randomUUID() }),randomUUID())).rejects.toThrow('WALLET_NOT_FOUND');
  await expect(services().process.execute(request(w,{ kind: 'BET',money: { amount: '0.00',currency: 'BRL' } }),randomUUID())).rejects.toThrow('INVALID_TRANSACTION_AMOUNT');
  expect(await count('wager_transactions',w.id)).toBe(1); await state(w.id);
});

async function threeProcesses(inputs: { body: unknown; key: string }[]): Promise<TransactionResult[]> {
  const children = inputs.map(() => Bun.spawn([process.execPath,'tests/support/process-wager-child.ts',schema],{
    stdin: 'pipe',stdout: 'pipe',stderr: 'pipe' }));
  try {
    const readers = children.map(child => child.stdout.getReader());
    await Promise.all(readers.map(async reader => {
      let ready = '';
      while (!ready.includes('\n')) { const chunk = await reader.read(); if (chunk.done) throw new Error('Child stopped before READY'); ready += new TextDecoder().decode(chunk.value); }
      if (ready.trim() !== 'READY') throw new Error('Invalid child readiness');
    }));
    children.forEach((child,i) => { child.stdin.write(JSON.stringify(inputs[i])); child.stdin.end(); });
    return await Promise.all(readers.map(async (reader,i) => {
      let output = '';
      while (true) { const chunk = await reader.read(); if (chunk.done) break; output += new TextDecoder().decode(chunk.value); }
      const exit = await children[i]!.exited;
      if (exit !== 0) throw new Error(await new Response(children[i]!.stderr).text());
      return JSON.parse(output.trim()) as TransactionResult;
    }));
  } finally {
    children.forEach(child => { if (child.exitCode === null) child.kill(); });
  }
}
test('three independent Bun processes replay the same operation without another debit',async () => {
  const w = await services().openWallet.execute(opening()); const body = request(w); const key = randomUUID();
  const results = await threeProcesses(Array.from({ length: 3 },() => ({ body,key })));
  expect(new Set(results.map(r => r.transactionId)).size).toBe(1);
  expect(results.filter(r => !r.idempotentReplay)).toHaveLength(1);
  expect(await count('wallet_ledger',w.id)).toBe(2); expect((await state(w.id)).balance).toBe('75.00');
},30000);
test('three independent processes preserve funds when two BETs compete with a LOSS',async () => {
  const w = await services().openWallet.execute(opening());
  const results = await threeProcesses([
    { body: request(w,{ money: { amount: '80.00',currency: 'BRL' } }),key: randomUUID() },
    { body: request(w,{ money: { amount: '80.00',currency: 'BRL' } }),key: randomUUID() },
    { body: request(w,{ kind: 'LOSS',money: { amount: '0.00',currency: 'BRL' } }),key: randomUUID() },
  ]);
  expect(results.filter(r => r.status === Status.Processed)).toHaveLength(2);
  expect(results.filter(r => r.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(1);
  expect(await count('wallet_ledger',w.id)).toBe(2); expect((await state(w.id)).balance).toBe('20.00');
},30000);

test('credit overflow is auditably rejected and its response replays without another effect',async () => {
  const w = await services().openWallet.execute(opening('999999999999999999.99'));
  const body = request(w,{ kind: 'WIN',money: { amount: '0.01',currency: 'BRL' } }); const key = randomUUID();
  const rejected = await services().process.execute(body,key);
  expect(rejected.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
  expect(rejected.status).toBe(Status.Rejected);
  expect(await services().process.execute(body,key)).toEqual({ ...rejected,idempotentReplay: true });
  expect(await count('wallet_ledger',w.id)).toBe(1);
  expect((await state(w.id)).balance).toBe('999999999999999999.99');
});
test('mutating a returned response cannot change the snapshot in PostgreSQL',async () => {
  const w = await services().openWallet.execute(opening()); const body = request(w); const key = randomUUID();
  const first = await services().process.execute(body,key); first.balance.amount = '999.00';
  const repeated = await services().process.execute(body,key);
  expect(repeated.balance.amount).toBe('75.00');
  await state(w.id);
});
test('replay after later operations and process restarts retains the original observed balance',async () => {
  const w = await services().openWallet.execute(opening()); const body = request(w); const key = randomUUID();
  const original = await services().process.execute(body,key);
  await services().process.execute(request(w,{ kind: 'WIN' }),randomUUID());
  const results = await threeProcesses(Array.from({ length: 3 },() => ({ body,key })));
  expect(results).toEqual(Array.from({ length: 3 },() => ({ ...original,idempotentReplay: true })));
  expect((await state(w.id)).balance).toBe('100.00');
},30000);

test('locking wallet A does not block processing wallet B',async () => {
  const [a,b] = await Promise.all([services().openWallet.execute(opening()),services().openWallet.execute(opening())]);
  let markLocked!: () => void; let release!: () => void;
  const locked = new Promise<void>(resolve => { markLocked = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holding = new MikroFinancialUnitOfWork(orm).run(async session => {
    await session.lockWallet(a.id); markLocked(); await gate;
  });
  try {
    await locked;
    const result = await services().process.execute(request(b),randomUUID());
    expect(result.status).toBe(Status.Processed);
    expect(result.balance.amount).toBe('75.00');
  } finally { release(); await holding; }
  await state(a.id); await state(b.id);
},30000);
test('taxonomy rollback refuses to discard existing new-code audit rows',async () => {
  const w = await services().openWallet.execute(opening('999999999999999999.99'));
  const result = await services().process.execute(request(w,{ kind: 'WIN',money: { amount: '0.01',currency: 'BRL' } }),randomUUID());
  expect(result.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
  await expect(orm.getMigrator().down()).rejects.toThrow();
  expect(await orm.getMigrator().getExecutedMigrations()).toHaveLength(2);
  await state(w.id);
});
