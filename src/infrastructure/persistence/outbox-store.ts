import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
export interface OutboxClaim { id: string; aggregateId: string; payload: Record<string,unknown>; attempts: number; token: string }
export class OutboxStore {
  private readonly table: string;
  constructor(private readonly orm: MikroORM) {
    const schema = orm.config.get('schema') ?? 'public';
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('INVALID_OUTBOX_SCHEMA');
    this.table = `"${schema}".outbox_messages`;
  }
  async claim(limit = 10,leaseMs = 30000): Promise<OutboxClaim[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(leaseMs) || leaseMs < 100) throw new Error('INVALID_CLAIM_OPTIONS');
    const token = randomUUID();
    return this.orm.em.fork().transactional(em => em.execute<OutboxClaim[]>(`with due as (
      select id from ${this.table} where published_at is null and (next_attempt_at is null or next_attempt_at<=clock_timestamp())
      and (lease_until is null or lease_until<=clock_timestamp()) order by occurred_at,id for update skip locked limit ?)
      update ${this.table} o set lease_token=?,lease_until=clock_timestamp()+(? * interval '1 millisecond'),attempts=attempts+1
      from due where o.id=due.id returning o.id,o.aggregate_id as "aggregateId",o.payload,o.attempts,o.lease_token as token`,[limit,token,leaseMs]));
  }
  private async update(claim: OutboxClaim,set: string,params: unknown[] = []): Promise<boolean> {
    const rows = await this.orm.em.getConnection().execute<{ id: string }[]>(`update ${this.table} set ${set}
      where id=? and lease_token=? and published_at is null and lease_until>clock_timestamp() returning id`,[...params,claim.id,claim.token]);
    return rows.length === 1;
  }
  renew(claim: OutboxClaim,leaseMs: number) { return this.update(claim,"lease_until=clock_timestamp()+(? * interval '1 millisecond')",[leaseMs]); }
  published(claim: OutboxClaim) { return this.update(claim,'published_at=clock_timestamp(),lease_token=null,lease_until=null'); }
  retry(claim: OutboxClaim,delayMs: number) { return this.update(claim,"next_attempt_at=clock_timestamp()+(? * interval '1 millisecond'),lease_token=null,lease_until=null",[delayMs]); }
  release(claim: OutboxClaim) { return this.update(claim,'lease_token=null,lease_until=null'); }
}
