import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { financialEntities } from './financial-records';

/** No connection is opened on import; each caller owns and closes its ORM. */
export function persistenceConfig() {
  const port = Number(process.env.DB_PORT ?? '5546');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_DB_PORT');
  const schema=process.env.DB_SCHEMA ?? 'public';
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('INVALID_DB_SCHEMA');
  return defineConfig({
    schema,
    host: process.env.DB_HOST ?? '127.0.0.1',
    port,
    user: process.env.DB_USER ?? 'ballance',
    password: process.env.DB_PASSWORD ?? 'local-development-only',
    dbName: process.env.DB_NAME ?? 'ballance',
    entities: financialEntities,
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      path: `${__dirname}/migrations`,
      pathTs: `${__dirname}/migrations`,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    debug: false,
    allowGlobalContext: false,
    pool: { min: 0, max: 5, acquireTimeoutMillis: 5000 },
    driverOptions: { connection: { connectionTimeoutMillis: 5000 } },
  });
}
