import { Migration } from '@mikro-orm/migrations';

/** Extend stable rejection taxonomy without editing the initial migration. */
export class Migration202610260002BalanceLimit extends Migration {
  private target(): string {
    const schema = this.config.get('schema') ?? 'public';
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('INVALID_MIGRATION_SCHEMA');
    return schema;
  }
  private constraint(includeLimit: boolean): string {
    return `check (failure_code is null or
      (status = 'FAILED' and failure_code = 'PERMANENT_INFRASTRUCTURE_FAILURE') or
      (status = 'REJECTED' and failure_code in ('WALLET_NOT_FOUND','PLAYER_MISMATCH','CURRENCY_MISMATCH',
        'INSUFFICIENT_FUNDS','REVERSAL_INSUFFICIENT_FUNDS','REFERENCE_MISMATCH','REFERENCE_KIND_INVALID',
        'REFERENCE_NOT_PROCESSED','REFERENCE_EXPIRED','REVERSAL_ALREADY_APPLIED'${includeLimit ? ",'BALANCE_LIMIT_EXCEEDED'" : ''})))`;
  }
  override async up(): Promise<void> {
    const schema = this.target();
    // Initial migration used an automatically named CHECK. Locate exactly its taxonomy definition.
    this.addSql(`do $$ declare name text; begin
      select conname into strict name from pg_catalog.pg_constraint
        where conrelid = '"${schema}".wager_transactions'::regclass and contype = 'c'
          and pg_catalog.pg_get_constraintdef(oid) like '%PERMANENT_INFRASTRUCTURE_FAILURE%';
      execute format('alter table %I.wager_transactions drop constraint %I','${schema}',name);
    end $$;
    alter table "${schema}".wager_transactions add constraint wager_failure_code_valid ${this.constraint(true)};`);
  }
  override async down(): Promise<void> {
    const schema = this.target();
    // Refuse rollback if new-code audit rows exist; never rewrite/delete financial history.
    this.addSql(`alter table "${schema}".wager_transactions drop constraint wager_failure_code_valid;
      alter table "${schema}".wager_transactions add constraint wager_failure_code_valid ${this.constraint(false)};`);
  }
}
