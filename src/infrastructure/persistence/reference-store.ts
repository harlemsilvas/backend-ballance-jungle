import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { ReferenceClaim } from '../../application/financial-ports';
export interface ReferenceJob extends ReferenceClaim { walletId: string; providerId: string; claims: number }
export class ReferenceStore {
  private readonly s: string;
  constructor(private readonly orm: MikroORM) {
    const schema=orm.config.get('schema') ?? 'public';
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('INVALID_REFERENCE_SCHEMA'); this.s=`"${schema}"`;
  }
  async claim(limit=10,leaseMs=30000): Promise<ReferenceJob[]> {
    if (!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(leaseMs)||leaseMs<100) throw new Error('INVALID_REFERENCE_CLAIM');
    const token=randomUUID();
    return this.orm.em.fork().transactional(async em => {
      await em.execute(`insert into ${this.s}.reference_jobs(transaction_id)
        select id from ${this.s}.wager_transactions where status='PENDING_REFERENCE' on conflict do nothing`);
      return em.execute<ReferenceJob[]>(`with due as (
        select j.transaction_id from ${this.s}.reference_jobs j join ${this.s}.wager_transactions t on t.id=j.transaction_id
        where t.status='PENDING_REFERENCE' and (t.next_reference_attempt_at is null or t.next_reference_attempt_at<=clock_timestamp()
          or t.created_at<=clock_timestamp()-interval '24 hours') and (j.lease_until is null or j.lease_until<=clock_timestamp())
        order by t.next_reference_attempt_at nulls first,t.id for update of j skip locked limit ?)
        update ${this.s}.reference_jobs j set lease_token=?,lease_until=clock_timestamp()+(? * interval '1 millisecond'),claims=claims+1
        from due,${this.s}.wager_transactions t where j.transaction_id=due.transaction_id and t.id=j.transaction_id
        returning j.transaction_id as "transactionId",j.lease_token as token,t.wallet_id as "walletId",t.provider_id as "providerId",j.claims`,[limit,token,leaseMs]);
    });
  }
  async release(claim: ReferenceClaim,delayMs=0): Promise<boolean> {
    const rows=await this.orm.em.getConnection().execute(`with owned as (select transaction_id from ${this.s}.reference_jobs
      where transaction_id=? and lease_token=? for update skip locked)
      update ${this.s}.reference_jobs j set lease_until=case when ?>0 then clock_timestamp()+(? * interval '1 millisecond') else null end,
      lease_token=case when ?>0 then lease_token else null end from owned where j.transaction_id=owned.transaction_id and j.lease_token=? returning j.transaction_id`,
      [claim.transactionId,claim.token,delayMs,delayMs,delayMs,claim.token]);
    return rows.length===1;
  }
}
