import { DomainError } from '../domain-error';

export interface EventContext {
  eventId: string; correlationId: string; causationId?: string; occurredAt: Date;
}
export interface IntegrationEventProps<T> extends EventContext { aggregateId: string; data: T }
export interface EventEnvelope<T> {
  eventId: string; eventType: string; aggregateId: string; correlationId: string;
  causationId?: string; occurredAt: string; version: number; data: Readonly<T>;
}
/** Own an immutable, JSON-only snapshot; reject classes such as Money and Date. */
function snapshot<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) throw new DomainError('INVALID_EVENT_DATA');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new DomainError('INVALID_EVENT_DATA');
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map(item => snapshot(item, seen))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, seen)]));
  seen.delete(value);
  return Object.freeze(result) as T;
}
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly data: Readonly<T>;
  private readonly occurredAtIso: string;
  protected constructor(props: IntegrationEventProps<T>) {
    for (const id of [props.eventId, props.aggregateId, props.correlationId]) {
      if (typeof id !== 'string' || !id.trim()) throw new DomainError('INVALID_EVENT_CONTEXT');
    }
    if (props.causationId !== undefined && (typeof props.causationId !== 'string' || !props.causationId.trim())) throw new DomainError('INVALID_EVENT_CONTEXT');
    if (!Number.isFinite(props.occurredAt.getTime())) throw new DomainError('INVALID_TIMESTAMP');
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) this.causationId = props.causationId;
    this.occurredAtIso = props.occurredAt.toISOString();
    this.data = snapshot(props.data);
  }
  get occurredAt(): Date { return new Date(this.occurredAtIso); }
  toJSON(): EventEnvelope<T> {
    return {
      eventId: this.eventId, eventType: this.eventType, aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.occurredAtIso, version: this.version, data: this.data,
    };
  }
}
