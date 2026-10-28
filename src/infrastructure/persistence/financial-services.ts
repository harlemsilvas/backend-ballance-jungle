import { NOOP_TELEMETRY,type Telemetry } from '../../application/telemetry';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { OpenWallet, ProcessWagerTransaction } from '../../application/financial-use-cases';
import type { ExecutionEnvironment } from '../../application/financial-ports';
import { MikroFinancialUnitOfWork } from './mikro-financial-unit-of-work';

export function financialServices(orm: MikroORM, env: ExecutionEnvironment = { now: () => new Date(),newId: randomUUID },telemetry: Telemetry=NOOP_TELEMETRY) {
  const uow = new MikroFinancialUnitOfWork(orm,telemetry);
  return { openWallet: new OpenWallet(uow,env,telemetry),process: new ProcessWagerTransaction(uow,env,telemetry) };
}
