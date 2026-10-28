import { expect, test } from 'bun:test';
import { WagerTransaction as Tx, WagerTransactionKind as Kind, WagerTransactionStatus as Status, type CreateWagerTransactionProps } from '../../src/domain/wager-transaction';
import { LedgerDirection as Direction } from '../../src/domain/wallet-ledger-entry';
import { Money } from '../../src/domain/money';
const at = new Date('2026-10-26T12:00:00Z');
const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
const props = (overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
  id: 'tx', providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key',
  payloadHash: 'a'.repeat(64), walletId: 'wallet', playerId: 'player', roundId: 'round', gameId: 'game',
  kind: Kind.Bet, money: money('25'), createdAt: new Date(at), ...overrides,
});
const processedBet = () => {
  const tx = Tx.create(props()); tx.markProcessed(undefined, at); return tx;
};
const reversal = (kind = Kind.Refund, overrides: Partial<CreateWagerTransactionProps> = {}) => Tx.create(props({
  id: 'reversal', externalTransactionId: 'reversal-external', idempotencyKey: 'key-reversal',
  kind, referenceExternalTransactionId: 'external', ...overrides,
}));

test.each([[Kind.Bet, Direction.Debit], [Kind.Win, Direction.Credit], [Kind.Loss, undefined]] as const)('%s has the expected financial direction', (kind, direction) => {
  const tx = Tx.create(props({ kind, money: money(kind === Kind.Loss ? '0' : '25') }));
  expect(tx.status).toBe(Status.Pending);
  expect(tx.ledgerDirectionFor()).toBe(direction);
  expect(tx.affectsBalance()).toBe(kind !== Kind.Loss);
  tx.markProcessed(undefined, at);
  expect(tx.status).toBe(Status.Processed);
});
test('OPENING has a separate internal factory', () => {
  expect(() => Tx.create(props({ kind: Kind.Opening }))).toThrow('OPENING_IS_INTERNAL');
  const tx = Tx.createOpening(props());
  expect(tx.kind).toBe(Kind.Opening);
  expect(tx.ledgerDirectionFor()).toBe(Direction.Credit);
});
test.each([Kind.Refund, Kind.Rollback])('%s requires a reference and exact reversal value', kind => {
  expect(() => Tx.create(props({ kind }))).toThrow('REFERENCE_REQUIRED');
  expect(() => reversal(kind, { money: money('24') }).validateReference(processedBet())).toThrow('REFERENCE_MISMATCH');
  const tx = reversal(kind);
  expect(tx.ledgerDirectionFor(processedBet())).toBe(Direction.Credit);
  tx.markProcessed(processedBet(), at);
  expect(tx.referenceTransactionId).toBe('tx');
});
test('WIN can reference BET with a different payout amount', () => {
  expect(reversal(Kind.Win, { money: money('100') }).ledgerDirectionFor(processedBet())).toBe(Direction.Credit);
});
test.each([Kind.Win, Kind.Refund])('ROLLBACK of %s is debit', kind => {
  const reference = kind === Kind.Refund ? reversal(kind) : Tx.create(props({ kind }));
  reference.markProcessed(kind === Kind.Refund ? processedBet() : undefined, at);
  const rollback = reversal(Kind.Rollback, { id: 'rollback', externalTransactionId: 'rollback-external', referenceExternalTransactionId: reference.externalTransactionId });
  expect(rollback.ledgerDirectionFor(reference)).toBe(Direction.Debit);
});
test('rejects rollback of LOSS and another ROLLBACK', () => {
  for (const kind of [Kind.Loss, Kind.Rollback]) {
    const reference = Tx.rehydrate({ ...props({ kind }), status: Status.Processed });
    expect(() => reversal(Kind.Rollback).validateReference(reference)).toThrow('REFERENCE_KIND_INVALID');
  }
});
test.each(['providerId', 'playerId', 'walletId', 'roundId', 'externalTransactionId'] as const)('reference must match %s', field => {
  const reference = Tx.rehydrate({ ...props({ [field]: 'other' }), status: Status.Processed });
  expect(() => reversal().validateReference(reference)).toThrow('REFERENCE_MISMATCH');
});
test('reference currency must match', () => {
  const reference = Tx.rehydrate({ ...props({ money: money('25', 'USD') }), status: Status.Processed });
  expect(() => reversal().validateReference(reference)).toThrow('REFERENCE_MISMATCH');
});
test('pending reference can be retried without transitioning a terminal state', () => {
  const tx = reversal();
  expect(() => tx.markProcessed(undefined, at)).toThrow('REFERENCE_REQUIRED');
  expect(() => tx.validateReference(Tx.create(props()))).toThrow('REFERENCE_PENDING');
  tx.markPendingReference(); tx.markPendingReference();
  expect(tx.status).toBe(Status.PendingReference);
  tx.markProcessed(processedBet(), at);
  expect(tx.status).toBe(Status.Processed);
});
test('rejected reference cannot be reversed and expired pending transaction is terminal', () => {
  const reference = Tx.create(props()); reference.reject('INSUFFICIENT_FUNDS');
  expect(() => reversal().validateReference(reference)).toThrow('REFERENCE_NOT_PROCESSED');
  const tx = reversal(); tx.markPendingReference(); tx.reject('REFERENCE_EXPIRED');
  expect(tx.failureCode).toBe('REFERENCE_EXPIRED');
  expect(tx.affectsBalance()).toBe(false);
});
test.each([Status.Processed, Status.Rejected, Status.Failed])('%s blocks every state transition', status => {
  const tx = Tx.rehydrate({ ...props(), status });
  for (const action of [() => tx.markProcessed(undefined, at), () => tx.markPendingReference(),
    () => tx.reject('INSUFFICIENT_FUNDS'), () => tx.fail('PERMANENT_INFRASTRUCTURE_FAILURE')]) {
    expect(action).toThrow('INVALID_TRANSACTION_STATE');
    expect(tx.status).toBe(status);
  }
});
test('validates amount, kind, identity, hash and timestamps', () => {
  for (const invalid of [props({ money: money('0') }), props({ kind: Kind.Loss }),
    props({ money: money('1').negate() }), props({ kind: 'INVALID' as Kind }),
    props({ id: ' ' }), props({ payloadHash: 'invalid' }), props({ createdAt: new Date('invalid') })]) {
    expect(() => Tx.create(invalid)).toThrow();
  }
});
test('forbids self references and references on BET/LOSS', () => {
  expect(() => reversal(Kind.Refund, { referenceExternalTransactionId: 'reversal-external' })).toThrow('INVALID_REFERENCE');
  expect(() => Tx.create(props({ referenceExternalTransactionId: 'other' }))).toThrow('REFERENCE_NOT_ALLOWED');
  expect(() => Tx.create(props({ kind: Kind.Loss, money: money('0'), referenceExternalTransactionId: 'other' }))).toThrow('REFERENCE_NOT_ALLOWED');
});
test('detects divergent payload without changing original transaction', () => {
  const tx = processedBet();
  tx.assertPayload('a'.repeat(64));
  expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  expect(() => tx.assertPayload('b'.repeat(64))).toThrow('IDEMPOTENCY_CONFLICT');
  expect(tx.status).toBe(Status.Processed);
});
test('processing validates timestamp and snapshots dates', () => {
  const input = props(); const tx = Tx.create(input);
  input.createdAt.setFullYear(2000);
  expect(tx.createdAt).toEqual(at);
  expect(() => tx.markProcessed(undefined, new Date('invalid'))).toThrow('INVALID_TIMESTAMP');
  expect(tx.status).toBe(Status.Pending);
  const processedAt = new Date(at); tx.markProcessed(undefined, processedAt);
  processedAt.setFullYear(2001); tx.processedAt?.setFullYear(2002);
  expect(tx.processedAt).toEqual(at);
});
test('rehydrate preserves a failed transaction and audit fields without transitions', () => {
  const tx = Tx.rehydrate({ ...props(), status: Status.Failed, failureCode: 'PERMANENT_INFRASTRUCTURE_FAILURE' });
  expect(tx.failureCode).toBe('PERMANENT_INFRASTRUCTURE_FAILURE');
  expect(tx.isTerminal()).toBe(true);
  expect(tx.affectsBalance()).toBe(false);
});

test('permanent infrastructure failure is terminal and auditably distinct from rejection', () => {
  for (const tx of [Tx.create(props()), reversal()]) {
    if (tx.requiresReference()) tx.markPendingReference();
    tx.fail('PERMANENT_INFRASTRUCTURE_FAILURE');
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe('PERMANENT_INFRASTRUCTURE_FAILURE');
    expect(tx.processedAt).toBeUndefined();
    expect(() => tx.markProcessed(processedBet(), at)).toThrow('INVALID_TRANSACTION_STATE');
  }
});
test('unreferenced operations cannot wait for or consume an unexpected reference', () => {
  const tx = Tx.create(props());
  expect(() => tx.markPendingReference()).toThrow('REFERENCE_NOT_ALLOWED');
  expect(() => tx.markProcessed(processedBet(), at)).toThrow('REFERENCE_NOT_ALLOWED');
  expect(tx.status).toBe(Status.Pending);
});
test('REFUND cannot reverse a processed WIN even when amounts match', () => {
  const reference = Tx.create(props({ kind: Kind.Win }));
  reference.markProcessed(undefined, at);
  expect(() => reversal().markProcessed(reference, at)).toThrow('REFERENCE_KIND_INVALID');
});
