import { expect, test } from 'bun:test';
import { IntegrationEvent, type EventContext } from '../../src/domain/events/integration-event';
import { WalletBalanceChanged, WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference } from '../../src/domain/events/wager-events';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WagerTransaction as Tx, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
const at = new Date('2026-10-26T12:00:00.000Z');
const ctx = (): EventContext => ({ eventId: 'event-1', correlationId: 'corr-1', causationId: 'msg-1', occurredAt: new Date(at) });
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const tx = (kind = Kind.Bet) => Tx.create({
  id: 'tx-1', providerId: 'provider-a', externalTransactionId: 'external-1', idempotencyKey: 'key', payloadHash: 'a'.repeat(64),
  walletId: 'wallet-1', playerId: 'player-1', roundId: 'round-1', gameId: 'game-1', kind,
  money: brl(kind === Kind.Loss ? '0' : '25'), createdAt: at,
  ...(kind === Kind.Refund ? { referenceExternalTransactionId: 'missing-bet' } : {}),
});
const wallet = () => Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl('100'), at,
  opening: { entryId: 'entry-opening', transactionId: 'tx-opening' } }).wallet;

test.each([Kind.Bet, Kind.Win, Kind.Loss])('processed event includes %s and serializes money as strings', kind => {
  const transaction = tx(kind); transaction.markProcessed(undefined, at);
  const event = WagerTransactionProcessed.from(transaction, ctx());
  const json = JSON.parse(JSON.stringify(event));
  expect(json.eventType).toBe('WagerTransactionProcessed');
  expect(json.version).toBe(1);
  expect(json.aggregateId).toBe('wallet-1');
  expect(json.occurredAt).toBe(at.toISOString());
  expect(json.data.money).toEqual({ amount: kind === Kind.Loss ? '0.00' : '25.00', currency: 'BRL' });
  expect(json.data.processedAt).toBe(at.toISOString());
  expect(json).toMatchObject({ eventId: 'event-1', correlationId: 'corr-1', causationId: 'msg-1' });
});
test('rejected event carries stable machine-readable failure code', () => {
  const transaction = tx(); transaction.reject('INSUFFICIENT_FUNDS');
  const event = WagerTransactionRejected.from(transaction, ctx());
  expect(event.eventType).toBe('WagerTransactionRejected');
  expect(event.data.failureCode).toBe('INSUFFICIENT_FUNDS');
  expect(event.data.money).not.toBeInstanceOf(Money);
});
test('pending-reference event snapshots state even if source is later rejected', () => {
  const transaction = tx(Kind.Refund); transaction.markPendingReference();
  const event = WagerTransactionPendingReference.from(transaction, ctx());
  transaction.reject('REFERENCE_EXPIRED');
  expect(event.data.status).toBe(Status.PendingReference);
  expect(event.data.referenceExternalTransactionId).toBe('missing-bet');
  expect(event.eventType).toBe('WagerTransactionPendingReference');
});
test('balance event uses the matching ledger movement and wallet version', () => {
  const w = wallet();
  const entry = w.debit(brl('25'), { entryId: 'entry-1', transactionId: 'tx-1', at });
  const event = WalletBalanceChanged.from(w, entry, ctx());
  expect(event.toJSON()).toMatchObject({ eventType: 'WalletBalanceChanged', version: 1,
    data: { walletVersion: 2, direction: 'DEBIT', money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' }, balanceAfter: { amount: '75.00', currency: 'BRL' } } });
});
test('invalid source status and stale wallet/ledger pairing are rejected', () => {
  expect(() => WagerTransactionProcessed.from(tx(), ctx())).toThrow('INVALID_EVENT_SOURCE');
  expect(() => WagerTransactionRejected.from(tx(), ctx())).toThrow('INVALID_EVENT_SOURCE');
  expect(() => WagerTransactionPendingReference.from(tx(Kind.Refund), ctx())).toThrow('INVALID_EVENT_SOURCE');
  const w = wallet(); const entry = w.debit(brl('25'), { entryId: 'e', transactionId: 't', at });
  w.credit(brl('1'), { entryId: 'e2', transactionId: 't2', at });
  expect(() => WalletBalanceChanged.from(w, entry, ctx())).toThrow('INVALID_EVENT_SOURCE');
});
test('event and nested payload are frozen; timestamps are defensive copies', () => {
  const transaction = tx(); transaction.markProcessed(undefined, at);
  const context = ctx(); const event = WagerTransactionProcessed.from(transaction, context);
  context.occurredAt.setFullYear(2000); event.occurredAt.setFullYear(2001);
  expect(event.toJSON().occurredAt).toBe(at.toISOString());
  expect(Object.isFrozen(event)).toBe(true);
  expect(Object.isFrozen(event.data.money)).toBe(true);
  expect(() => { (event.data.money as { amount: string }).amount = '999'; }).toThrow();
  expect(event.data.money.amount).toBe('25.00');
  const first = JSON.stringify(event); const second = JSON.stringify(event);
  expect(first).toBe(second);
});
test('optional causationId is omitted rather than serialized as null', () => {
  const transaction = tx(); transaction.markProcessed(undefined, at);
  const event = WagerTransactionProcessed.from(transaction, { eventId: 'e', correlationId: 'c', occurredAt: at });
  expect(Object.hasOwn(event.toJSON(), 'causationId')).toBe(false);
});
test('invalid context and invalid event timestamps are rejected', () => {
  const transaction = tx(); transaction.markProcessed(undefined, at);
  expect(() => WagerTransactionProcessed.from(transaction, { ...ctx(), eventId: '' })).toThrow('INVALID_EVENT_CONTEXT');
  expect(() => WagerTransactionProcessed.from(transaction, { ...ctx(), occurredAt: new Date('invalid') })).toThrow('INVALID_TIMESTAMP');
});
class ProbeEvent extends IntegrationEvent<unknown> {
  readonly eventType = 'Probe'; readonly version = 1;
  constructor(data: unknown) { super({ ...ctx(), aggregateId: 'a', data }); }
}
test('base event snapshots nested JSON and rejects class instances, cycles and non-JSON values', () => {
  const input = { nested: [{ amount: '1.00' }] }; const event = new ProbeEvent(input);
  input.nested[0]!.amount = '999';
  expect(event.data).toEqual({ nested: [{ amount: '1.00' }] });
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  for (const invalid of [brl('1'), new Date(), cycle, { missing: undefined }, { number: NaN }, { value: 1n }]) {
    expect(() => new ProbeEvent(invalid)).toThrow('INVALID_EVENT_DATA');
  }
});
