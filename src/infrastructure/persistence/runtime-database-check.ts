import type { MikroORM } from '@mikro-orm/postgresql';

export async function assertRuntimeDatabase(orm: MikroORM): Promise<void> {
  const schema = orm.config.get('schema') ?? 'public';
  const [row] = await orm.em.getConnection().execute<{
    elevated: boolean; owns: boolean; ledgerMutable: boolean; migrated: boolean;
  }[]>(`select (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls) as elevated,
    exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname=? and c.relname in ('wallets','wager_transactions','wallet_ledger','inbox_messages','outbox_messages','reference_jobs')
      and pg_catalog.pg_has_role(current_user,c.relowner,'USAGE')) as owns,
    coalesce(pg_catalog.has_table_privilege(current_user,pg_catalog.to_regclass(?),'UPDATE,DELETE,TRUNCATE'),false) as "ledgerMutable",
    exists(select 1 from pg_catalog.pg_constraint c where c.conrelid=pg_catalog.to_regclass(?)
      and c.conname='wager_failure_code_valid' and pg_catalog.pg_get_constraintdef(c.oid) like '%BALANCE_LIMIT_EXCEEDED%') as migrated
    from pg_catalog.pg_roles r where r.rolname=current_user`,
    [schema,`"${schema.replaceAll('"','""')}".wallet_ledger`,`"${schema.replaceAll('"','""')}".wager_transactions`]);
  if (!row || row.elevated || row.owns || row.ledgerMutable) throw new Error('RESTRICTED_RUNTIME_ROLE_REQUIRED');
  const [jobs]=await orm.em.getConnection().execute<{ present: boolean }[]>('select pg_catalog.to_regclass(?) is not null as present',[`"${schema.replaceAll('"','""')}".reference_jobs`]);
  if (!row.migrated || !jobs?.present) throw new Error('FINANCIAL_MIGRATIONS_REQUIRED');
}
