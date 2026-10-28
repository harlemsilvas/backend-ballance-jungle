import { MikroORM } from '@mikro-orm/postgresql';
import { persistenceConfig } from '../infrastructure/persistence/mikro-orm.config';
import { assertRuntimeDatabase } from '../infrastructure/persistence/runtime-database-check';
import { runtimeGrantSql } from '../infrastructure/persistence/runtime-grants';

let phase = 'configuration';

// Administrative, explicit one-shot command. Never imported by API/workers.
async function main() {
  const schema = process.env.DB_SCHEMA;
  const role = process.env.RUNTIME_DB_USER;
  const password = process.env.RUNTIME_DB_PASSWORD;
  if (!schema || schema === 'public' || !role || ![schema,role].every(v => /^[a-z][a-z0-9_]*$/.test(v)) || !password || password.length < 16) {
    throw new Error('INVALID_PROVISION_CONFIGURATION');
  }
  phase = 'connect';
  const orm = await MikroORM.init(persistenceConfig());
  try {
    const db = orm.em.getConnection();
    // No takeover of an unrelated role/schema, no password rotation on rerun.
    phase = 'schema_and_role';
    await db.transactional(async connection => {
      await db.execute("select pg_advisory_xact_lock(26301, 1)",[], 'all',connection);
      const roles = await db.execute('select 1 from pg_roles where rolname=?',[role],'all',connection);
      const schemas = await db.execute('select 1 from pg_namespace where nspname=?',[schema],'all',connection);
      if (roles.length || schemas.length) {
        if (!roles.length || !schemas.length) throw new Error('PARTIAL_PROVISION_STATE');
        const existing = await db.execute(`select obj_description(oid,'pg_namespace') as marker from pg_namespace where nspname=?`,[schema],'all',connection);
        if (existing[0]?.marker !== `backend-ballance runtime:${role}`) throw new Error('UNMANAGED_SCHEMA');
      } else {
        await db.execute("select set_config('ballance_provision.password',?,true)",[password],'all',connection);
        await db.execute(`do $$ begin execute format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls','${role}',current_setting('ballance_provision.password')); end $$`,[], 'all',connection);
        await db.execute(`create schema "${schema}"`,[], 'all',connection);
        await db.execute(`comment on schema "${schema}" is 'backend-ballance runtime:${role}'`,[], 'all',connection);
      }
      await db.execute(`revoke all on schema "${schema}" from public`,[], 'all',connection);
    });
    phase = 'migrations';
    await orm.getMigrator().up();
    phase = 'grants';
    for (const sql of runtimeGrantSql(schema,role)) await db.execute(sql);
    phase = 'runtime_check';
    const runtime = await MikroORM.init({ ...persistenceConfig(),user: role,password });
    try { await assertRuntimeDatabase(runtime); } finally { await runtime.close(true); }
    console.log(JSON.stringify({event:'RuntimeProvisioned',schema,role}));
  } finally { await orm.close(true); }
}
void main().catch((error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,60}$/.test(error.code) ? error.code : 'PROVISION_FAILED';
  console.error(JSON.stringify({event:'RuntimeProvisionFailed',phase,code})); process.exitCode=1;
});
