import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { HealthController } from '../interfaces/http/health.controller';
import { createFinancialHttpApp } from '../interfaces/http/financial-http';
import { persistenceConfig } from '../infrastructure/persistence/mikro-orm.config';
import { assertRuntimeDatabase } from '../infrastructure/persistence/runtime-database-check';

@Module({ controllers: [HealthController] })
class HealthOnlyModule {}

async function bootstrap(): Promise<void> {
  const enabled = process.env.FINANCIAL_API_ENABLED ?? 'false';
  if (!['true','false'].includes(enabled)) throw new Error('INVALID_FINANCIAL_API_ENABLED');
  if (enabled === 'true' && (process.env.AUTH_MODE !== 'local-development' || process.env.NODE_ENV === 'production')) {
    throw new Error('EXPLICIT_LOCAL_AUTH_MODE_REQUIRED');
  }
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT');
  let orm: MikroORM | undefined; let app: INestApplication | undefined;
  try {
    if (enabled === 'true') {
      orm = await MikroORM.init(persistenceConfig());
      await assertRuntimeDatabase(orm);
      const owned = orm;
      app = await createFinancialHttpApp(orm,{ onClose: () => owned.close(true) });
    } else app = await NestFactory.create(HealthOnlyModule,{ logger: false });
    app.enableShutdownHooks();
    await app.listen(port,process.env.HTTP_HOST ?? '127.0.0.1');
    console.log(JSON.stringify({ level: 'info',event: 'ApplicationStarted',port,financialApiEnabled: enabled === 'true' }));
  } catch (error) {
    if (app) await app.close();
    else if (orm) await orm.close(true);
    throw error;
  }
}
void bootstrap().catch(error => {
  const code = error instanceof Error && ['RESTRICTED_RUNTIME_ROLE_REQUIRED','FINANCIAL_MIGRATIONS_REQUIRED',
    'EXPLICIT_LOCAL_AUTH_MODE_REQUIRED','INVALID_FINANCIAL_API_ENABLED','INVALID_PORT'].includes(error.message)
    ? error.message : 'APPLICATION_STARTUP_FAILED';
  console.error(JSON.stringify({ level: 'error',code })); process.exitCode = 1;
});
