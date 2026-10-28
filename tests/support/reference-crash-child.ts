import { MikroORM } from '@mikro-orm/postgresql';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { financialServices } from '../../src/infrastructure/persistence/financial-services';
import { ReferenceStore } from '../../src/infrastructure/persistence/reference-store';
import { ReferenceScheduler } from '../../src/infrastructure/messaging/reference-scheduler';
async function main() {
  const schema=process.argv[2]; if (!schema||!/^bb_test_[a-f0-9]{32}$/.test(schema)) throw new Error('ISOLATED_SCHEMA_REQUIRED');
  const orm=await MikroORM.init({ ...persistenceConfig(),schema });
  try { await new ReferenceScheduler(new ReferenceStore(orm),financialServices(orm).process,{
    afterClaim: async () => { console.log('CLAIMED'); await new Response(Bun.stdin.stream()).text(); },
  }).tick(); } finally { await orm.close(true); }
}
void main().catch(() => { console.error('REFERENCE_CHILD_FAILED'); process.exitCode=1; });
