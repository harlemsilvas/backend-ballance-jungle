import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../domain/money';
import { DomainError } from '../domain/domain-error';
import { WagerTransactionKind } from '../domain/wager-transaction';

type ExternalKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
export interface WagerPayload {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: ExternalKind; money: Readonly<MoneyProps>;
  referenceExternalTransactionId?: string;
}
export interface PreparedWagerCommand {
  payload: Readonly<WagerPayload>; idempotencyKey: string; canonicalPayload: string; payloadHash: string;
}
const fields = ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money'];
function record(input: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new DomainError('INVALID_PAYLOAD');
  const result = input as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(result, key))
    || Object.keys(result).some(key => ![...required, ...optional].includes(key))) throw new DomainError('INVALID_PAYLOAD');
  return result;
}
function identifier(input: unknown): string {
  if (typeof input !== 'string' || !input || input !== input.trim()) throw new DomainError('INVALID_PAYLOAD');
  return input;
}
/** Restricted canonical encoding: validated business payload contains only strings and plain objects. */
function canonical(input: unknown): string {
  if (typeof input === 'string') return JSON.stringify(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DomainError('INVALID_PAYLOAD');
  const value = input as Record<string, unknown>;
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
export function normalizeWagerPayload(input: unknown): Readonly<WagerPayload> {
  const value = record(input, fields, ['referenceExternalTransactionId']);
  const amount = record(value.money, ['amount', 'currency']);
  if (typeof amount.amount !== 'string' || typeof amount.currency !== 'string') throw new DomainError('INVALID_PAYLOAD');
  // Challenge permits a single public currency; Money itself remains multi-currency.
  if (amount.currency !== 'BRL') throw new DomainError('UNSUPPORTED_CURRENCY');
  const money = Object.freeze(Money.from({ amount: amount.amount, currency: amount.currency }).toJSON());
  const kind = identifier(value.kind) as ExternalKind;
  if (kind === (WagerTransactionKind.Opening as string)) throw new DomainError('OPENING_IS_INTERNAL');
  if (!Object.values(WagerTransactionKind).includes(kind)) throw new DomainError('INVALID_TRANSACTION_KIND');
  const result: WagerPayload = {
    providerId: identifier(value.providerId), externalTransactionId: identifier(value.externalTransactionId),
    playerId: identifier(value.playerId), walletId: identifier(value.walletId),
    roundId: identifier(value.roundId), gameId: identifier(value.gameId), kind, money,
  };
  if (Object.hasOwn(value, 'referenceExternalTransactionId')) {
    result.referenceExternalTransactionId = identifier(value.referenceExternalTransactionId);
  }
  return Object.freeze(result);
}
export function prepareWagerCommand(input: unknown, idempotencyKey: unknown): Readonly<PreparedWagerCommand> {
  const key = identifier(idempotencyKey);
  const payload = normalizeWagerPayload(input);
  const canonicalPayload = canonical(payload);
  const payloadHash = createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
  return Object.freeze({ payload, idempotencyKey: key, canonicalPayload, payloadHash });
}
/** Envelope validation shared by future SQS adapters; broker attributes are not business fields. */
export function prepareSqsWagerRequest(input: unknown): {
  messageId: string; occurredAt: string; transportHash: string; command: Readonly<PreparedWagerCommand>;
} {
  const envelope = record(input, ['messageId', 'type', 'occurredAt', 'data']);
  if (envelope.type !== 'WagerTransactionRequested') throw new DomainError('INVALID_PAYLOAD');
  const messageId = identifier(envelope.messageId);
  const occurredAt = identifier(envelope.occurredAt);
  if (!Number.isFinite(Date.parse(occurredAt)) || new Date(occurredAt).toISOString() !== occurredAt) throw new DomainError('INVALID_TIMESTAMP');
  const data = record(envelope.data, [...fields, 'idempotencyKey'], ['referenceExternalTransactionId']);
  const { idempotencyKey, ...business } = data;
  return { messageId, occurredAt, transportHash: createHash('sha256').update(canonical(input),'utf8').digest('hex'), command: prepareWagerCommand(business, idempotencyKey) };
}
