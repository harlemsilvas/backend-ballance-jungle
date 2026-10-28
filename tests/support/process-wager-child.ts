import { MikroORM } from '@mikro-orm/postgresql';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { financialServices } from '../../src/infrastructure/persistence/financial-services';

async function main(): Promise<void> {
  const schema = process.argv[2];
  if (!schema || !/^bb_test_[a-f0-9]{32}$/.test(schema)) throw new Error('ISOLATED_SCHEMA_REQUIRED');
  const orm = await MikroORM.init({ ...persistenceConfig(),schema });
  try {
    console.log('READY');
    // Parent releases all independent processes only after every one reports READY.
    const request = JSON.parse(await new Response(Bun.stdin.stream()).text()) as { body: unknown; key: string };
    const result = await financialServices(orm).process.execute(request.body,request.key);
    console.log(JSON.stringify(result));
  } finally { await orm.close(true); }
}
void main().catch(() => { console.error('CHILD_PROCESS_FAILED'); process.exitCode = 1; });
