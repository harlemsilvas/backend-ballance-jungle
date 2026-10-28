import { test,expect } from 'bun:test';
import { randomUUID,randomBytes } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { assertRuntimeDatabase } from '../../src/infrastructure/persistence/runtime-database-check';

test('explicit provision creates restricted persistent runtime, reruns, and refuses unmanaged schemas',async () => {
  const suffix=randomUUID().replaceAll('-','');
  const schema=`bb_test_${suffix}`,role=`bb_role_${suffix}`,foreign=`bb_test_foreign_${suffix}`;
  const password=randomBytes(24).toString('hex');
  const admin=await MikroORM.init(persistenceConfig());
  const run=async (target=schema,secret=password) => {
    const child=Bun.spawn([process.execPath,'src/bootstrap/provision-runtime.ts'],{env:{...process.env,
      DB_SCHEMA:target,RUNTIME_DB_USER:role,RUNTIME_DB_PASSWORD:secret},stdout:'pipe',stderr:'pipe'});
    const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(out+err).not.toContain(password);
    return code;
  };
  try {
    expect(await run()).toBe(0);
    const runtime=await MikroORM.init({...persistenceConfig(),schema,user:role,password});
    try {
      await assertRuntimeDatabase(runtime);
      expect(await runtime.em.getConnection().execute(`select * from "${schema}".wallets`)).toEqual([]);
      await expect(runtime.em.getConnection().execute(`delete from "${schema}".wallet_ledger`)).rejects.toThrow();
    } finally {await runtime.close(true);}
    expect(await run()).toBe(0);
    expect(await run(schema,randomBytes(24).toString('hex'))).toBe(1);
    await admin.em.getConnection().execute(`create schema "${foreign}"`);
    expect(await run(foreign)).toBe(1);
    const [row]=await admin.em.getConnection().execute<{count:string}[]>(`select count(*)::text as count from "${schema}".mikro_orm_migrations`);
    expect(row?.count).toBe('3');
  } finally {
    await admin.em.getConnection().execute(`drop schema if exists "${foreign}" cascade`);
    await admin.em.getConnection().execute(`drop schema if exists "${schema}" cascade`);
    const roles=await admin.em.getConnection().execute('select 1 from pg_roles where rolname=?',[role]);
    if(roles.length) await admin.em.getConnection().execute(`drop role "${role}"`);
    await admin.close(true);
  }
},30000);
