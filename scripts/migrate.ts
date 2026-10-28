import { MikroORM } from '@mikro-orm/postgresql';
import { persistenceConfig } from '../src/infrastructure/persistence/mikro-orm.config';

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action !== 'up' && action !== 'down' && action !== 'pending') {
    throw new Error('Usage: bun scripts/migrate.ts up|down|pending');
  }
  const orm = await MikroORM.init(persistenceConfig());
  try {
    const migrator = orm.getMigrator();
    if (action === 'pending') console.log(await migrator.getPendingMigrations());
    if (action === 'up') await migrator.up();
    // Explicit command rolls back only the last migration, never the entire history.
    if (action === 'down') await migrator.down();
  } finally {
    await orm.close(true);
  }
}

void main().catch(() => {
  console.error("Migration command failed; verify database configuration and migration state");
  process.exitCode = 1;
});
