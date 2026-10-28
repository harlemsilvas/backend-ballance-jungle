import { Migration } from '@mikro-orm/migrations';
export class Migration202610260003ReferenceJobs extends Migration {
  private target() {
    const schema=this.config.get('schema') ?? 'public';
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('INVALID_MIGRATION_SCHEMA'); return `"${schema}"`;
  }
  override async up(): Promise<void> {
    const s=this.target();
    this.addSql(`create table ${s}.reference_jobs (
      transaction_id uuid primary key references ${s}.wager_transactions(id) on delete restrict,
      lease_token uuid,lease_until timestamptz,claims integer not null default 0 check (claims>=0),
      check ((lease_token is null)=(lease_until is null))
    );
    create index reference_jobs_lease on ${s}.reference_jobs(lease_until,transaction_id);
    revoke all on ${s}.reference_jobs from public;`);
  }
  override async down(): Promise<void> { this.addSql(`drop table ${this.target()}.reference_jobs;`); }
}
