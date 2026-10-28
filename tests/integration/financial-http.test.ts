import { beforeAll,afterAll,expect,test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { Migration202610260001FinancialSchema } from '../../src/infrastructure/persistence/migrations/Migration202610260001FinancialSchema';
import { Migration202610260002BalanceLimit } from '../../src/infrastructure/persistence/migrations/Migration202610260002BalanceLimit';
import { Migration202610260003ReferenceJobs } from '../../src/infrastructure/persistence/migrations/Migration202610260003ReferenceJobs';
import { createFinancialHttpApp } from '../../src/interfaces/http/financial-http';
import { financialServices } from '../../src/infrastructure/persistence/financial-services';
import { MikroFinancialUnitOfWork } from '../../src/infrastructure/persistence/mikro-financial-unit-of-work';
import { ProcessWagerTransaction,OpenWallet } from '../../src/application/financial-use-cases';
import type { FinancialUnitOfWork,TransactionResult } from '../../src/application/financial-ports';
import type { WalletView,LedgerPage,ReconciliationView } from '../../src/application/financial-queries';
import { assertRuntimeDatabase } from '../../src/infrastructure/persistence/runtime-database-check';
import { WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { runtimeGrantSql } from '../../src/infrastructure/persistence/runtime-grants';

const schema = `bb_test_${randomUUID().replaceAll('-', '')}`; const s = `"${schema}"`;
let orm: MikroORM; let app: INestApplication; let base: string;
async function call<T = Record<string,unknown>>(path: string,method = 'GET',body?: unknown,headers: Record<string,string> = {},url = base) {
  const response = await fetch(url+path,{ method,headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status,data: await response.json() as T,headers: response.headers };
}
async function wallet(amount = '100.00') {
  const response = await call<WalletView>('/wallets','POST',{ playerId: randomUUID(),initialBalance: { amount,currency: 'BRL' } });
  expect(response.status).toBe(201); return response.data;
}
const body = (w: WalletView,extras: Record<string,unknown> = {}) => ({ providerId: 'provider-a',externalTransactionId: randomUUID(),
  playerId: w.playerId,walletId: w.id,roundId: 'round',gameId: 'game',kind: 'BET',money: { amount: '25.00',currency: 'BRL' },...extras });
const submit = (request: unknown,key = randomUUID()) => call<TransactionResult>('/wagering/transactions','POST',request,{ 'Idempotency-Key': key });
beforeAll(async () => {
  const config = persistenceConfig();
  orm = await MikroORM.init({ ...config,schema,migrations: { ...config.migrations,
    tableName: `${schema}.mikro_orm_migrations`,migrationsList: [
      { name: 'Migration202610260001FinancialSchema',class: Migration202610260001FinancialSchema },
      { name: 'Migration202610260002BalanceLimit',class: Migration202610260002BalanceLimit },
      { name: 'Migration202610260003ReferenceJobs',class: Migration202610260003ReferenceJobs },
    ] } });
  await orm.em.getConnection().execute(`create schema ${s}`); await orm.getMigrator().up();
  app = await createFinancialHttpApp(orm); await app.listen(0,'127.0.0.1'); base = await app.getUrl();
},30000);
afterAll(async () => {
  if (app) await app.close();
  if (orm) {
    try { await orm.em.getConnection().execute(`drop schema if exists ${s} cascade`); }
    finally { await orm.close(true); }
  }
});

test('health is open and wallet creation/lookup serialize money and version',async () => {
  expect((await call('/health/live')).status).toBe(200);
  const w = await wallet();
  const found = await call<WalletView>(`/wallets/${w.id}`);
  expect(found.data).toEqual(w); expect(found.data.balance.amount).toBe('100.00'); expect(found.data.version).toBe(1);
});
test('strict wallet contracts reject extra keys, numeric amount, malformed UUID and unsupported currency',async () => {
  const input = { playerId: randomUUID(),initialBalance: { amount: '1.00',currency: 'BRL' } };
  for (const invalid of [{ ...input,extra: true },{ ...input,playerId: 'bad' },
    { ...input,initialBalance: { amount: 1,currency: 'BRL' } },{ ...input,initialBalance: { amount: '1',currency: 'BRL',extra: true } },
    { ...input,initialBalance: { amount: '1',currency: 'USD' } }]) {
    expect((await call('/wallets','POST',invalid)).status).toBe(400);
  }
  expect((await call('/wallets','POST',input)).status).toBe(201);
  expect((await call('/wallets','POST',input)).status).toBe(409);
});
test('POST requires key, returns 200 for processing and replays historical balance',async () => {
  const w = await wallet(); const request = body(w); const key = randomUUID();
  expect((await call('/wagering/transactions','POST',request)).status).toBe(400);
  const first = await submit(request,key); expect(first.status).toBe(200);
  await submit(body(w,{ kind: 'WIN' }));
  const replay = await submit(request,key);
  expect(replay.status).toBe(200); expect(replay.data).toEqual({ ...first.data,idempotentReplay: true });
  expect((await call<WalletView>(`/wallets/${w.id}`)).data.balance.amount).toBe('100.00');
  expect(replay.data.balance.amount).toBe('75.00');
});
test('API distinguishes payload errors, identity conflicts, business rejection and pending reference',async () => {
  const w = await wallet(); const request = body(w); const key = randomUUID();
  const processed = await submit(request,key); expect(processed.status).toBe(200);
  expect((await submit({ ...request,money: { amount: '24',currency: 'BRL' } },key)).status).toBe(409);
  expect((await submit(request)).status).toBe(409);
  expect((await submit({ ...body(w),extra: true })).status).toBe(400);
  expect((await submit(body(w,{ kind: 'OPENING' }))).status).toBe(400);
  const rejected = await submit(body(w,{ money: { amount: '101',currency: 'BRL' } }));
  expect(rejected.status).toBe(422); expect(rejected.data.failureCode).toBe('INSUFFICIENT_FUNDS');
  const pending = await submit(body(w,{ kind: 'REFUND',referenceExternalTransactionId: randomUUID() }));
  expect(pending.status).toBe(202); expect(pending.data.status).toBe(Status.PendingReference);
});
test('transaction queries return 200 for rejected records and expose the persisted result',async () => {
  const w = await wallet(); const request = body(w,{ money: { amount: '101',currency: 'BRL' } });
  const rejected = await submit(request);
  const internal = await call(`/wagering/transactions/${rejected.data.transactionId}`);
  const external = await call(`/providers/provider-a/wagering/transactions/${request.externalTransactionId}`);
  expect(internal.status).toBe(200); expect(internal.data.status).toBe('REJECTED');
  expect(internal.data.result).toEqual(rejected.data); expect(external.data).toEqual(internal.data);
});
test('unknown resources are 404, malformed UUID is 400 and errors preserve correlation ID',async () => {
  const id = 'test-correlation-123';
  const missing = await call(`/wallets/${randomUUID()}`,'GET',undefined,{ 'X-Correlation-Id': id });
  expect(missing.status).toBe(404); expect(missing.data.correlationId).toBe(id);
  expect(missing.headers.get('x-correlation-id')).toBe(id);
  expect((await call('/wallets/bad')).status).toBe(400);
  expect((await call(`/wagering/transactions/${randomUUID()}`)).status).toBe(404);
});
test('ledger paginates stably without duplicates and rejects cross-wallet/malformed cursors',async () => {
  const w = await wallet(); await submit(body(w)); await submit(body(w,{ kind: 'WIN' }));
  const ids: string[] = []; let cursor: string | null = null; let firstCursor = '';
  do {
    const page: { status: number; data: LedgerPage } = await call<LedgerPage>(`/wallets/${w.id}/ledger?limit=1${cursor ? '&cursor='+cursor : ''}`);
    expect(page.status).toBe(200); ids.push(...page.data.items.map(item => item.id));
    cursor = page.data.nextCursor; if (!firstCursor && cursor) firstCursor = cursor;
  } while (cursor);
  expect(ids).toHaveLength(3); expect(new Set(ids).size).toBe(3);
  const other = await wallet();
  expect((await call(`/wallets/${other.id}/ledger?cursor=${firstCursor}`)).status).toBe(400);
  for (const query of ['limit=0','limit=101','limit=abc','limit=1&limit=2','cursor=bad','unexpected=true']) {
    expect((await call(`/wallets/${w.id}/ledger?${query}`)).status).toBe(400);
  }
});
test('ledger cursor retains microseconds instead of truncating to JavaScript Date',async () => {
  const id = randomUUID(); const player = randomUUID();
  await orm.em.fork().transactional(async em => {
    await em.execute(`insert into ${s}.wallets values (?,?,'BRL',0,1,now(),now())`,[id,player]);
    for (let i=1;i<=3;i++) {
      const tx = randomUUID(); const at = `2026-10-26T12:00:00.00000${i}Z`;
      await em.execute(`update ${s}.wallets set balance=?,version=version+1 where id=?`,[`${i}.00`,id]);
      await em.execute(`insert into ${s}.wager_transactions
        (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,created_at,processed_at,result_snapshot)
        values (?,'provider-a',?,?,?, ?,?,'round','game','WIN',1,'BRL','PROCESSED',?,?,'{}')`,[tx,tx,tx,'a'.repeat(64),id,player,at,at]);
      // Explicit column order avoids relying on the physical table layout.
      await em.execute(`insert into ${s}.wallet_ledger
        (id,wallet_id,transaction_id,currency,direction,amount,balance_before,balance_after,wallet_version,created_at)
        values (?,?,?,'BRL','CREDIT',1,?,?,?,?)`,[randomUUID(),id,tx,`${i-1}.00`,`${i}.00`,i+1,at]);
    }
  });
  const times: string[] = []; let cursor: string | null = null;
  do {
    const page: { data: LedgerPage } = await call<LedgerPage>(`/wallets/${id}/ledger?limit=1${cursor ? '&cursor='+cursor : ''}`);
    times.push(...page.data.items.map(item => item.createdAt)); cursor = page.data.nextCursor;
  } while (cursor);
  expect(times).toEqual([1,2,3].map(i => `2026-10-26T12:00:00.00000${i}Z`));
});
test('reconciliation uses a consistent snapshot while a financial commit is in flight',async () => {
  const w = await wallet();
  let written!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { written=resolve; }); const gate = new Promise<void>(resolve => { release=resolve; });
  const real = new MikroFinancialUnitOfWork(orm);
  const delayed: FinancialUnitOfWork = { run: work => real.run(async session => { const result=await work(session); written(); await gate; return result; }) };
  const processor = new ProcessWagerTransaction(delayed,{ now: () => new Date(),newId: randomUUID });
  const processing = processor.execute(body(w),randomUUID());
  try {
    await ready;
    const before = await call<ReconciliationView>(`/wallets/${w.id}/reconciliation`,'POST');
    expect(before.status).toBe(200); expect(before.data.consistent).toBe(true); expect(before.data.storedBalance.amount).toBe('100.00');
  } finally { release(); await processing; }
  const after = await call<ReconciliationView>(`/wallets/${w.id}/reconciliation`,'POST');
  expect(after.data.consistent).toBe(true); expect(after.data.storedBalance.amount).toBe('75.00'); expect(after.data.checkedEntries).toBe(2);
});
test('divergence is returned, counted and logged without silently repairing the balance',async () => {
  const w = await wallet();
  const metricsBefore = await (await fetch(base+'/metrics')).text();
  const prior = Number(metricsBefore.match(/divergences_total (\d+)/)?.[1]);
  await orm.em.getConnection().execute(`alter table ${s}.wallets disable trigger user`);
  try {
    // Deliberate corruption by the test owner only; normal runtime cannot disable triggers.
    await orm.em.getConnection().execute(`update ${s}.wallets set balance='90.00' where id=?`,[w.id]);
    const result = await call<ReconciliationView>(`/wallets/${w.id}/reconciliation`,'POST');
    expect(result.status).toBe(200); expect(result.data.consistent).toBe(false); expect(result.data.difference.amount).toBe('-10.00');
    expect((await call<WalletView>(`/wallets/${w.id}`)).data.balance.amount).toBe('90.00');
    const metrics = await (await fetch(base+'/metrics')).text();
    expect(metrics).toContain(`divergences_total ${prior+1}`);
  } finally {
    await orm.em.getConnection().execute(`update ${s}.wallets set balance='100.00' where id=?`,[w.id]);
    await orm.em.getConnection().execute(`alter table ${s}.wallets enable trigger user`);
  }
});
test('identity port rejects provider mismatch while health stays open',async () => {
  const restricted = await createFinancialHttpApp(orm,{ identity: { resolve: async () => ({ providerId: 'provider-a' }) } });
  try {
    await restricted.listen(0,'127.0.0.1'); const url = await restricted.getUrl();
    expect((await call('/health/live','GET',undefined,{},url)).status).toBe(200);
    const w = await wallet();
    expect((await call('/wagering/transactions','POST',body(w,{ providerId: 'provider-b' }),{ 'Idempotency-Key': randomUUID() },url)).status).toBe(403);
  } finally { await restricted.close(); }
});
test('transient infrastructure errors are 503 without exposing internal error text',async () => {
  const failing: FinancialUnitOfWork = { run: async () => { throw Object.assign(new Error('PRIVATE_INTERNAL_DETAIL'),{ code: 'ECONNREFUSED' }); } };
  const environment = { now: () => new Date(),newId: randomUUID };
  const failedApp = await createFinancialHttpApp(orm,{ services: {
    openWallet: new OpenWallet(failing,environment),process: new ProcessWagerTransaction(failing,environment) } });
  try {
    await failedApp.listen(0,'127.0.0.1'); const w = await wallet();
    const result = await call('/wagering/transactions','POST',body(w),{ 'Idempotency-Key': randomUUID() },await failedApp.getUrl());
    expect(result.status).toBe(503); expect(result.data.code).toBe('INFRASTRUCTURE_UNAVAILABLE');
    expect(JSON.stringify(result.data)).not.toContain('PRIVATE_INTERNAL_DETAIL');
  } finally { await failedApp.close(); }
});
test('runtime startup check refuses admin/owner and accepts a restricted non-owner role',async () => {
  await expect(assertRuntimeDatabase(orm)).rejects.toThrow('RESTRICTED_RUNTIME_ROLE_REQUIRED');
  const role = `bb_role_${randomUUID().replaceAll('-', '')}`; let limited: MikroORM | undefined;
  await orm.em.getConnection().execute(`create role "${role}" nologin`);
  try {
    for (const sql of runtimeGrantSql(schema,role)) await orm.em.getConnection().execute(sql);
    limited = await MikroORM.init({ ...persistenceConfig(),schema,pool: { min: 0,max: 1 } });
    // Dedicated one-connection test pool; no application connection has its role changed.
    await limited.em.getConnection().execute(`set role "${role}"`);
    await assertRuntimeDatabase(limited);
    const w = await financialServices(limited).openWallet.execute({ playerId: randomUUID(),initialBalance: { amount: '1.00',currency: 'BRL' } });
    expect(w.balance.amount).toBe('1.00');
  } finally {
    if (limited) await limited.close(true);
    await orm.em.getConnection().execute(`revoke all on all tables in schema ${s} from "${role}"`);
    await orm.em.getConnection().execute(`revoke all on all functions in schema ${s} from "${role}"`);
    await orm.em.getConnection().execute(`revoke all on schema ${s} from "${role}"`);
    await orm.em.getConnection().execute(`drop role "${role}"`);
  }
});

test('readiness checks real PostgreSQL/SQS and reports dependency failure separately from liveness',async () => {
  expect((await call('/health/ready')).status).toBe(200);
  const unavailable = await createFinancialHttpApp(orm,{ readiness: async () => { throw new Error('DEPENDENCY_DOWN'); } });
  try {
    await unavailable.listen(0,'127.0.0.1'); const url = await unavailable.getUrl();
    expect((await call('/health/live','GET',undefined,{},url)).status).toBe(200);
    const ready = await call('/health/ready','GET',undefined,{},url);
    expect(ready.status).toBe(503); expect(ready.data.code).toBe('INFRASTRUCTURE_UNAVAILABLE');
  } finally { await unavailable.close(); }
});
