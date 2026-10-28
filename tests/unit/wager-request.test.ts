import { expect, test } from 'bun:test';
import { prepareWagerCommand, prepareSqsWagerRequest } from '../../src/application/wager-request';
const body = () => ({ providerId: 'provider-a', externalTransactionId: 'tx-1', playerId: 'player-1',
  walletId: 'wallet-1', roundId: 'round-1', gameId: 'game-1', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } });
const envelope = () => ({ messageId: 'msg-1', type: 'WagerTransactionRequested',
  occurredAt: '2026-10-26T12:00:00.000Z', data: { ...body(), idempotencyKey: 'provider-a:tx-1' } });
test('canonical JSON and SHA-256 match an independently computed golden vector', () => {
  const command = prepareWagerCommand(body(), 'key');
  expect(command.canonicalPayload).toBe('{"externalTransactionId":"tx-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-a","roundId":"round-1","walletId":"wallet-1"}');
  expect(command.payloadHash).toBe('12c5795427591de8e251ce67cd108dde35f710ff85790f627c4d3739ff3f2b3d');
});
test('key order at both levels and accepted decimal representations do not affect hash', () => {
  const original = body();
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  reordered.money = { currency: 'BRL', amount: '25' };
  expect(prepareWagerCommand(reordered, 'key').payloadHash).toBe(prepareWagerCommand(original, 'key').payloadHash);
});
test('HTTP and SQS share canonical payload; transport identifiers and timestamps are excluded', () => {
  const http = prepareWagerCommand(body(), 'http-key');
  const first = prepareSqsWagerRequest(envelope());
  const modified = envelope(); modified.messageId = 'msg-2'; modified.occurredAt = '2026-10-27T12:00:00.000Z'; modified.data.idempotencyKey = 'other-key';
  const second = prepareSqsWagerRequest(modified);
  expect(first.command.payloadHash).toBe(http.payloadHash);
  expect(second.command.payloadHash).toBe(http.payloadHash);
  expect(second.command.idempotencyKey).toBe('other-key');
  expect(http.canonicalPayload).not.toContain('idempotencyKey');
  expect(http.canonicalPayload).not.toContain('messageId');
});
test.each(['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind'] as const)('changing %s changes the hash', key => {
  const original = prepareWagerCommand(body(), 'key');
  const changed = { ...body(), [key]: key === 'kind' ? 'WIN' : 'different' };
  expect(prepareWagerCommand(changed, 'key').payloadHash).not.toBe(original.payloadHash);
});
test('money and reference participate in hash; absent reference is omitted', () => {
  const original = prepareWagerCommand(body(), 'key');
  expect(prepareWagerCommand({ ...body(), money: { amount: '26.00', currency: 'BRL' } }, 'key').payloadHash).not.toBe(original.payloadHash);
  const win = { ...body(), kind: 'WIN' };
  const withRef = prepareWagerCommand({ ...win, referenceExternalTransactionId: 'bet-1' }, 'key');
  expect(withRef.payloadHash).not.toBe(prepareWagerCommand(win, 'key').payloadHash);
  expect(withRef.canonicalPayload).toContain('"referenceExternalTransactionId":"bet-1"');
  expect(original.canonicalPayload).not.toContain('referenceExternalTransactionId');
});
test('unknown fields, transport fields in business payload and missing keys are rejected', () => {
  const { gameId, ...missing } = body();
  for (const invalid of [missing, { ...body(), extra: true }, { ...body(), correlationId: 'c' },
    { ...body(), idempotencyKey: 'key' }, { ...body(), money: { amount: '25', currency: 'BRL', extra: true } },
    null, [], new Date(), { ...body(), providerId: 123 }, { ...body(), playerId: ' ' }]) {
    expect(() => prepareWagerCommand(invalid, 'key')).toThrow('INVALID_PAYLOAD');
  }
});
test('rejects invalid money and unsupported public currencies before hashing', () => {
  for (const amount of ['NaN', 'Infinity', '1e2', '', '-1', '1.001', 25]) {
    expect(() => prepareWagerCommand({ ...body(), money: { amount, currency: 'BRL' } }, 'key')).toThrow();
  }
  expect(() => prepareWagerCommand({ ...body(), money: { amount: '25', currency: 'USD' } }, 'key')).toThrow('UNSUPPORTED_CURRENCY');
});
test('key must be explicit and identifiers are never silently trimmed', () => {
  for (const key of [undefined, null, '', ' key ', 1]) expect(() => prepareWagerCommand(body(), key)).toThrow('INVALID_PAYLOAD');
  expect(() => prepareWagerCommand({ ...body(), walletId: ' wallet-1' }, 'key')).toThrow('INVALID_PAYLOAD');
});
test('rejects null/undefined reference, OPENING and unknown operation kinds', () => {
  for (const referenceExternalTransactionId of [null, undefined, '', 1]) {
    expect(() => prepareWagerCommand({ ...body(), referenceExternalTransactionId }, 'key')).toThrow('INVALID_PAYLOAD');
  }
  expect(() => prepareWagerCommand({ ...body(), kind: 'OPENING' }, 'key')).toThrow('OPENING_IS_INTERNAL');
  expect(() => prepareWagerCommand({ ...body(), kind: 'OTHER' }, 'key')).toThrow('INVALID_TRANSACTION_KIND');
});
test('normalized payload owns a frozen snapshot of input', () => {
  const input = body(); const command = prepareWagerCommand(input, 'key');
  input.money.amount = '999'; input.walletId = 'changed';
  expect(command.payload.money.amount).toBe('25.00');
  expect(command.payload.walletId).toBe('wallet-1');
  expect(Object.isFrozen(command.payload.money)).toBe(true);
  expect(Object.isFrozen(command.payload)).toBe(true);
});
test('validates SQS envelope, explicit key and canonical ISO timestamp', () => {
  const { idempotencyKey, ...missingKey } = envelope().data;
  for (const invalid of [{ ...envelope(), type: 'Other' }, { ...envelope(), occurredAt: 'invalid' },
    { ...envelope(), occurredAt: '2026-02-30T12:00:00.000Z' }, { ...envelope(), data: missingKey },
    { ...envelope(), messageId: '' }, { ...envelope(), extra: 'value' }]) expect(() => prepareSqsWagerRequest(invalid)).toThrow();
});
