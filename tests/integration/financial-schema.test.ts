import { beforeAll, afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { Migration202610260001FinancialSchema } from '../../src/infrastructure/persistence/migrations/Migration202610260001FinancialSchema';
import { WalletSchema, WagerTransactionSchema, WalletLedgerSchema } from '../../src/infrastructure/persistence/financial-records';
import { WalletMapper } from '../../src/infrastructure/persistence/wallet-mapper';
import { runtimeGrantSql } from '../../src/infrastructure/persistence/runtime-grants';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

const schema = `bb_test_${randomUUID().replaceAll('-', '')}`;
const s = `"${schema}"`;
let orm: MikroORM;
interface Fixture { id: string; playerId: string }
interface TxOptions {
  kind?: string; status?: string; amount?: string; provider?: string; external?: string; key?: string;
  referenceId?: string; referenceExternal?: string; playerId?: string; round?: string; currency?: string;
}
async function addTx(em: EntityManager, w: Fixture, opts: TxOptions = {}) {
  const id = randomUUID(); const external = opts.external ?? id; const key = opts.key ?? id;
  const status = opts.status ?? 'PENDING';
  await em.execute(`insert into ${s}.wager_transactions
    (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,
      kind,amount,currency,reference_external_transaction_id,reference_transaction_id,status,failure_code,created_at,processed_at,result_snapshot)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,now(),?,?::jsonb)`,
    [id,opts.provider ?? 'provider',external,key,'a'.repeat(64),w.id,opts.playerId ?? w.playerId,opts.round ?? 'round','game',
      opts.kind ?? 'BET',opts.amount ?? '25.00',opts.currency ?? 'BRL',opts.referenceExternal ?? null,opts.referenceId ?? null,status,
      status === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : status === 'FAILED' ? 'PERMANENT_INFRASTRUCTURE_FAILURE' : null,
      status === 'PROCESSED' ? new Date() : null,
      ['PROCESSED','REJECTED','FAILED'].includes(status) ? JSON.stringify({ status, balance: { amount: '0.00', currency: 'BRL' } }) : null]);
  return { id, external, key };
}
async function ledger(em: EntityManager, w: Fixture, tx: string, amount: string, before: string, after: string, version: number, direction: string) {
  const id = randomUUID();
  await em.execute(`insert into ${s}.wallet_ledger
    (id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,wallet_version,created_at)
    values (?,?,?,?,?,'BRL',?,?,?,now())`, [id,w.id,tx,direction,amount,before,after,version]);
  return id;
}
async function seed(amount = '100.00'): Promise<Fixture> {
  const w = { id: randomUUID(), playerId: randomUUID() };
  await orm.em.fork().transactional(async em => {
    const opened = Wallet.open({ id: w.id, playerId: w.playerId, initialBalance: Money.from({ amount, currency: 'BRL' }),
      at: new Date(), opening: { entryId: randomUUID(), transactionId: randomUUID() } });
    const row = em.create(WalletSchema,WalletMapper.toRow(opened.wallet));
    await em.persistAndFlush(row);
    if (amount !== '0.00') {
      const opening = await addTx(em,w,{ kind: 'OPENING', status: 'PROCESSED', amount, provider: '_internal' });
      await ledger(em,w,opening.id,amount,'0.00',amount,1,'CREDIT');
    }
  });
  return w;
}
async function move(em: EntityManager, w: Fixture, opts: TxOptions = {}) {
  const [row] = await em.execute<{ balance: string; version: number }[]>(`select balance,version from ${s}.wallets where id=? for update`,[w.id]);
  if (!row) throw new Error('Missing fixture wallet');
  const amount = opts.amount ?? '25.00';
  let direction = (opts.kind ?? 'BET') === 'BET' ? 'DEBIT' : 'CREDIT';
  if (opts.kind === 'ROLLBACK' && opts.referenceId) {
    const [reference] = await em.execute<{ kind: string }[]>(`select kind from ${s}.wager_transactions where id=?`,[opts.referenceId]);
    direction = reference?.kind === 'BET' ? 'CREDIT' : 'DEBIT';
  }
  const before = Money.rehydrate({ amount: row.balance, currency: 'BRL' });
  const delta = Money.from({ amount, currency: 'BRL' });
  const after = (direction === 'DEBIT' ? before.subtract(delta) : before.add(delta)).toString();
  await em.execute(`update ${s}.wallets set balance=?,version=version+1,updated_at=now() where id=?`,[after,w.id]);
  const transaction = await addTx(em,w,{ ...opts, status: 'PROCESSED', amount });
  const entryId = await ledger(em,w,transaction.id,amount,row.balance,after,row.version+1,direction);
  return { ...transaction, entryId };
}
const raw = () => orm.em.fork();

beforeAll(async () => {
  const base = persistenceConfig();
  // Never share an application schema, table or migration history with this suite.
  orm = await MikroORM.init({ ...base, schema, migrations: { ...base.migrations,
    migrationsList: [{ name: 'Migration202610260001FinancialSchema', class: Migration202610260001FinancialSchema }],
    tableName: `${schema}.mikro_orm_migrations`,
  } });
  await orm.em.getConnection().execute(`create schema ${s}`);
  await orm.getMigrator().up();
}, 30000);
afterAll(async () => {
  if (!orm) return;
  try { await orm.em.getConnection().execute(`drop schema if exists ${s} cascade`); }
  finally { await orm.close(true); }
});

test('financial migration supports up/down/up in an isolated schema', async () => {
  expect(await orm.getMigrator().getExecutedMigrations()).toHaveLength(1);
  await orm.getMigrator().down();
  const [absent] = await raw().execute<{ name: string | null }[]>('select to_regclass(?) as name',[`${schema}.wallets`]);
  expect(absent?.name).toBeNull();
  await orm.getMigrator().up();
  expect(await orm.getMigrator().getExecutedMigrations()).toHaveLength(1);
});
test('ORM maps maximum numeric exactly through Wallet, transaction and ledger records', async () => {
  const w = await seed('999999999999999999.99'); const em = raw();
  const row = await em.findOneOrFail(WalletSchema,{ id: w.id });
  expect(typeof row.balance).toBe('string');
  expect(WalletMapper.fromRow(row).balance.toString()).toBe('999999999999999999.99');
  expect(WalletMapper.toRow(WalletMapper.fromRow(row)).balance).toBe(row.balance);
  const transaction = await em.findOneOrFail(WagerTransactionSchema,{ walletId: w.id });
  const entry = await em.findOneOrFail(WalletLedgerSchema,{ walletId: w.id });
  expect(transaction.amount).toBe(row.balance);
  expect(entry.amount).toBe(row.balance);
  expect(entry.balanceBefore).toBe('0.00');
});
test('unique wallet ownership, non-negativity and finite numeric are schema constraints', async () => {
  const w = await seed('0.00');
  await expect(raw().execute(`insert into ${s}.wallets values (?,?,'BRL',0,1,now(),now())`,[randomUUID(),w.playerId])).rejects.toThrow();
  for (const amount of ['-0.01','NaN','Infinity','0.001','0.000','1000000000000000000.00']) {
    await expect(raw().execute(`insert into ${s}.wallets values (?,?,'BRL',?,1,now(),now())`,[randomUUID(),randomUUID(),amount])).rejects.toThrow();
  }
});
test('global key and provider/external identity are independently unique', async () => {
  const w = await seed(); const first = await addTx(raw(),w);
  await expect(addTx(raw(),w,{ key: first.key })).rejects.toThrow();
  await expect(addTx(raw(),w,{ external: first.external })).rejects.toThrow();
  const other = await addTx(raw(),w,{ provider: 'other-provider', external: first.external });
  expect(other.id).not.toBe(first.id);
});
test('deferred balance/ledger checks roll back inbox and outbox with an incomplete movement', async () => {
  const w = await seed(); const message = randomUUID(); const event = randomUUID();
  await expect(raw().transactional(async em => {
    await em.execute(`insert into ${s}.inbox_messages values ('test',?, ?,now(),now())`,[message,'b'.repeat(64)]);
    const occurredAt = new Date();
    const payload = { eventId: event, aggregateId: w.id, eventType: 'WalletBalanceChanged', version: 1,
      correlationId: message, occurredAt: occurredAt.toISOString(), data: {} };
    await em.execute(`insert into ${s}.outbox_messages (id,aggregate_id,event_type,payload,occurred_at) values (?,?,'WalletBalanceChanged',?::jsonb,?)`,
      [event,w.id,JSON.stringify(payload),occurredAt]);
    await em.execute(`update ${s}.wallets set balance=75,version=2 where id=?`,[w.id]);
  })).rejects.toThrow('WALLET_LEDGER_DIVERGENCE');
  const [row] = await raw().execute<{ balance: string; version: number }[]>(`select balance,version from ${s}.wallets where id=?`,[w.id]);
  expect(row).toEqual({ balance: '100.00', version: 1 });
  expect(await raw().execute(`select 1 from ${s}.inbox_messages where message_id=?`,[message])).toHaveLength(0);
  expect(await raw().execute(`select 1 from ${s}.outbox_messages where id=?`,[event])).toHaveLength(0);
});
test('processed financial transactions require ledger; LOSS needs none', async () => {
  const w = await seed();
  await expect(raw().transactional(em => addTx(em,w,{ status: 'PROCESSED' }))).rejects.toThrow('TRANSACTION_LEDGER_MISMATCH');
  const loss = await addTx(raw(),w,{ kind: 'LOSS', amount: '0.00', status: 'PROCESSED' });
  await addTx(raw(),w,{ status: 'REJECTED' });
  await addTx(raw(),w,{ status: 'FAILED' });
  expect(loss.id).toBeTruthy();
  await expect(raw().transactional(async em => {
    await em.execute(`update ${s}.wallets set balance=101,version=2 where id=?`,[w.id]);
    await ledger(em,w,loss.id,'1.00','100.00','101.00',2,'CREDIT');
  })).rejects.toThrow();
});
test('ledger UPDATE, DELETE, TRUNCATE and terminal result mutation are blocked', async () => {
  const w = await seed(); const movement = await raw().transactional(em => move(em,w));
  await expect(raw().execute(`update ${s}.wallet_ledger set amount=amount where id=?`,[movement.entryId])).rejects.toThrow('LEDGER_IMMUTABLE');
  await expect(raw().execute(`delete from ${s}.wallet_ledger where id=?`,[movement.entryId])).rejects.toThrow('FINANCIAL_AUDIT_IMMUTABLE');
  await expect(raw().execute(`truncate ${s}.wallet_ledger`)).rejects.toThrow('FINANCIAL_AUDIT_IMMUTABLE');
  await expect(raw().execute(`update ${s}.wager_transactions set result_snapshot='{}'::jsonb where id=?`,[movement.id])).rejects.toThrow('TRANSACTION_TERMINAL_IMMUTABLE');
});
test('wallet version and ledger identity cannot be forged', async () => {
  const w = await seed(); const movement = await raw().transactional(em => move(em,w));
  await expect(raw().execute(`update ${s}.wallets set version=version+1 where id=?`,[w.id])).rejects.toThrow('WALLET_VERSION_MISMATCH');
  await expect(ledger(raw(),w,movement.id,'25.00','75.00','50.00',3,'DEBIT')).rejects.toThrow();
  const other = await seed();
  await expect(ledger(raw(),other,movement.id,'25.00','100.00','75.00',2,'DEBIT')).rejects.toThrow();
});
test('full reversal once per type; different reversal types remain permitted by specification', async () => {
  const w = await seed(); const bet = await raw().transactional(em => move(em,w));
  const reference = { referenceId: bet.id, referenceExternal: bet.external };
  await raw().transactional(em => move(em,w,{ kind: 'REFUND', ...reference }));
  await expect(raw().transactional(em => move(em,w,{ kind: 'REFUND', ...reference }))).rejects.toThrow();
  await raw().transactional(em => move(em,w,{ kind: 'ROLLBACK', ...reference }));
  const [row] = await raw().execute<{ balance: string; version: number }[]>(`select balance,version from ${s}.wallets where id=?`,[w.id]);
  expect(row).toEqual({ balance: '125.00', version: 4 });
});
test('mismatched reference amount, provider and round cannot commit', async () => {
  const w = await seed(); const bet = await raw().transactional(em => move(em,w));
  for (const mismatch of [{ amount: '24.00' },{ provider: 'other' },{ round: 'other' }]) {
    await expect(raw().transactional(em => move(em,w,{ kind: 'REFUND', referenceId: bet.id, referenceExternal: bet.external, ...mismatch })))
      .rejects.toThrow('TRANSACTION_LEDGER_MISMATCH');
  }
});
test('balanced totals alone cannot hide a forged ledger chain', async () => {
  const w = await seed();
  await expect(raw().transactional(async em => {
    await em.execute(`update ${s}.wallets set balance=110,version=2 where id=?`,[w.id]);
    const win = await addTx(em,w,{ kind: 'WIN', amount: '10.00', status: 'PROCESSED' });
    await ledger(em,w,win.id,'10.00','200.00','210.00',2,'CREDIT');
    await em.execute(`update ${s}.wallets set balance=100,version=3 where id=?`,[w.id]);
    const bet = await addTx(em,w,{ amount: '10.00', status: 'PROCESSED' });
    await ledger(em,w,bet.id,'10.00','210.00','200.00',3,'DEBIT');
  })).rejects.toThrow('LEDGER_CHAIN_MISMATCH');
});
test('pending identity, inbox identity and outbox envelope are protected', async () => {
  const w = await seed(); const pending = await addTx(raw(),w);
  await expect(raw().execute(`update ${s}.wager_transactions set payload_hash=? where id=?`,['b'.repeat(64),pending.id])).rejects.toThrow('TRANSACTION_IDENTITY_IMMUTABLE');
  const message = randomUUID();
  await raw().execute(`insert into ${s}.inbox_messages values ('test',?,?,now(),null)`,[message,'a'.repeat(64)]);
  await expect(raw().execute(`insert into ${s}.inbox_messages values ('test',?,?,now(),null)`,[message,'a'.repeat(64)])).rejects.toThrow();
  await expect(raw().execute(`update ${s}.inbox_messages set payload_hash=? where message_id=?`,['b'.repeat(64),message])).rejects.toThrow('INBOX_IDENTITY_IMMUTABLE');
  await expect(raw().execute(`insert into ${s}.outbox_messages (id,aggregate_id,event_type,payload,occurred_at) values (?,?,'WalletBalanceChanged','{}',now())`,[randomUUID(),w.id])).rejects.toThrow();
});
test('non-owner runtime role cannot UPDATE, DELETE or TRUNCATE the ledger', async () => {
  const role = `bb_role_${randomUUID().replaceAll('-', '')}`;
  const w = await seed();
  await raw().execute(`create role "${role}" nologin`);
  try {
    for (const sql of runtimeGrantSql(schema,role,false)) await raw().execute(sql);
    await raw().transactional(async em => {
      await em.execute(`set local role "${role}"`);
      await move(em,w);
    });
    const [balance] = await raw().execute<{ balance: string }[]>(`select balance from ${s}.wallets where id=?`,[w.id]);
    expect(balance?.balance).toBe('75.00');
    for (const sql of [`update ${s}.wallet_ledger set amount=amount where wallet_id='${w.id}'`,
      `delete from ${s}.wallet_ledger where wallet_id='${w.id}'`, `truncate ${s}.wallet_ledger`]) {
      await expect(raw().transactional(async em => {
        await em.execute(`set local role "${role}"`);
        await em.execute(sql);
      })).rejects.toThrow('permission denied');
    }
  } finally {
    await raw().execute(`revoke all on all tables in schema ${s} from "${role}"`);
    await raw().execute(`revoke all on all functions in schema ${s} from "${role}"`);
    await raw().execute(`revoke all on schema ${s} from "${role}"`);
    await raw().execute(`drop role "${role}"`);
  }
});

test('ROLLBACK of a processed WIN debits its exact amount', async () => {
  const w = await seed(); const win = await raw().transactional(em => move(em,w,{ kind: 'WIN' }));
  await raw().transactional(em => move(em,w,{ kind: 'ROLLBACK', referenceId: win.id, referenceExternal: win.external }));
  const [row] = await raw().execute<{ balance: string; version: number }[]>(`select balance,version from ${s}.wallets where id=?`,[w.id]);
  expect(row).toEqual({ balance: '100.00', version: 3 });
});
test('a gap in ledger wallet_version cannot commit', async () => {
  const w = await seed('0.00');
  await expect(raw().transactional(async em => {
    await em.execute(`update ${s}.wallets set balance='10.00',version=2 where id=?`,[w.id]);
    const win = await addTx(em,w,{ kind: 'WIN', amount: '10.00', status: 'PROCESSED' });
    await ledger(em,w,win.id,'10.00','0.00','10.00',3,'CREDIT');
  })).rejects.toThrow('TRANSACTION_LEDGER_MISMATCH');
});
test('outbox permits delivery metadata updates, but event payload and eventId are immutable', async () => {
  const w = await seed(); const id = randomUUID(); const at = new Date();
  const payload = { eventId: id, aggregateId: w.id, eventType: 'WalletBalanceChanged', version: 1,
    correlationId: randomUUID(), occurredAt: at.toISOString(), data: {} };
  await raw().execute(`insert into ${s}.outbox_messages (id,aggregate_id,event_type,payload,occurred_at) values (?,?,'WalletBalanceChanged',?::jsonb,?)`,[id,w.id,JSON.stringify(payload),at]);
  await raw().execute(`update ${s}.outbox_messages set attempts=1,next_attempt_at=now() where id=?`,[id]);
  await expect(raw().execute(`update ${s}.outbox_messages set payload='{}'::jsonb where id=?`,[id])).rejects.toThrow('OUTBOX_EVENT_IMMUTABLE');
});
test('pending reference cannot regress and processed inbox cannot be reset', async () => {
  const w = await seed();
  const pending = await addTx(raw(),w,{ kind: 'REFUND', status: 'PENDING_REFERENCE', referenceExternal: 'missing' });
  await expect(raw().execute(`update ${s}.wager_transactions set status='PENDING' where id=?`,[pending.id])).rejects.toThrow('INVALID_TRANSACTION_TRANSITION');
  const message = randomUUID();
  await raw().execute(`insert into ${s}.inbox_messages values ('test',?,?,now(),now())`,[message,'a'.repeat(64)]);
  await expect(raw().execute(`update ${s}.inbox_messages set processed_at=null where message_id=?`,[message])).rejects.toThrow('INBOX_IDENTITY_IMMUTABLE');
});
