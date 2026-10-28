import 'reflect-metadata';
import { PrometheusTelemetry } from '../../infrastructure/observability/telemetry';
import { MetricsCollector } from '../../infrastructure/observability/metrics-collector';
import { NOOP_TELEMETRY,type Telemetry } from '../../application/telemetry';
import { randomUUID } from 'node:crypto';
import { SQSClient,ListQueuesCommand } from '@aws-sdk/client-sqs';
import { Body,Catch,Controller,Get,Post,Param,Query,Headers,Req,Res,Inject,Module,UseGuards,HttpException,
  type CanActivate,type ExecutionContext,type ExceptionFilter,type ArgumentsHost } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { FinancialQueries } from '../../application/financial-queries';
import type { RequestContext,TransactionResult } from '../../application/financial-ports';
import { DomainError } from '../../domain/domain-error';
import { Money } from '../../domain/money';
import { financialServices } from '../../infrastructure/persistence/financial-services';
import { MikroFinancialQueries } from '../../infrastructure/persistence/mikro-financial-queries';
import { HealthController } from './health.controller';

const SERVICES = Symbol('financial-services'); const QUERIES = Symbol('financial-queries');
const IDENTITY = Symbol('provider-identity'); const METRICS = Symbol('metrics'); const READINESS = Symbol('readiness');
interface HttpRequest { headers: Record<string,string | string[] | undefined>; body?: unknown;
  params?: Record<string,string>; correlationId?: string }
interface HttpResponse { status(code: number): HttpResponse; json(body: unknown): void; setHeader(name: string,value: string): void }
export interface ProviderIdentityPort { resolve(authorization: string | undefined): Promise<{ providerId: string } | undefined> }
export class LocalDevelopmentIdentity implements ProviderIdentityPort {
  async resolve(): Promise<undefined> { return undefined; }
}
class ProviderGuard implements CanActivate {
  constructor(@Inject(IDENTITY) private readonly identity: ProviderIdentityPort) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest<HttpRequest>();
    const authorization = request.headers.authorization;
    const identity = await this.identity.resolve(typeof authorization === 'string' ? authorization : undefined);
    const body = request.body as { providerId?: unknown } | undefined;
    const provider = request.params?.providerId ?? body?.providerId;
    if (identity && provider !== undefined && provider !== identity.providerId) throw new HttpException('PROVIDER_FORBIDDEN',403);
    return true;
  }
}
function context(request: HttpRequest): RequestContext { return { correlationId: request.correlationId ?? randomUUID() }; }
function strictObject(input: unknown,keys: string[]): Record<string,unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DomainError('INVALID_PAYLOAD');
  const object = input as Record<string,unknown>;
  if (Object.keys(object).length !== keys.length || keys.some(key => !Object.hasOwn(object,key))) throw new DomainError('INVALID_PAYLOAD');
  return object;
}
function openInput(raw: unknown) {
  const value = strictObject(raw,['playerId','initialBalance']);
  const balance = strictObject(value.initialBalance,['amount','currency']);
  if (typeof value.playerId !== 'string' || typeof balance.amount !== 'string' || typeof balance.currency !== 'string') throw new DomainError('INVALID_PAYLOAD');
  return { playerId: value.playerId,initialBalance: Money.from({ amount: balance.amount,currency: balance.currency }).toJSON() };
}
function resultStatus(result: TransactionResult): number {
  if (result.status === 'PROCESSED') return 200;
  if (result.status === 'REJECTED') return 422;
  if (result.status === 'FAILED') return 500;
  return 202;
}
@Catch()
class FinancialExceptionFilter implements ExceptionFilter {
  constructor(private readonly telemetry: Telemetry=NOOP_TELEMETRY) {}
  catch(error: unknown,host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<HttpRequest>();
    const response = host.switchToHttp().getResponse<HttpResponse>();
    let status = 500; let code = 'INTERNAL_ERROR';
    if (error instanceof HttpException) {
      status = error.getStatus(); code = status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'PROVIDER_FORBIDDEN' : status === 404 ? 'RESOURCE_NOT_FOUND' : status === 503 ? 'INFRASTRUCTURE_UNAVAILABLE' : 'INVALID_PAYLOAD';
    } else if (error instanceof DomainError) {
      code = error.code;
      if (['WALLET_NOT_FOUND','TRANSACTION_NOT_FOUND'].includes(code)) status = 404;
      else if (['WALLET_ALREADY_EXISTS','IDEMPOTENCY_CONFLICT','EXTERNAL_TRANSACTION_CONFLICT'].includes(code)) status = 409;
      else if (['INVALID_PAYLOAD','INVALID_CURSOR','INVALID_PROVIDER','UNSUPPORTED_CURRENCY','OPENING_IS_INTERNAL',
        'INVALID_TRANSACTION_KIND','INVALID_TRANSACTION_AMOUNT','REFERENCE_REQUIRED','REFERENCE_NOT_ALLOWED','INVALID_REFERENCE'].includes(code)) status = 400;
    } else if (error instanceof Error && ['INVALID_MONEY_AMOUNT','INVALID_CURRENCY','MONEY_OUT_OF_RANGE'].includes(error.message)) {
      status = 400; code = error.message;
    }
    const sqlCode = (error as { code?: string } | null)?.code;
    if (['40001','40P01','55P03','ECONNREFUSED','ETIMEDOUT','57P01','08006'].includes(sqlCode ?? '')) {
      status = 503; code = 'INFRASTRUCTURE_UNAVAILABLE';
    }
    // Never expose raw SQL/error text or financial payloads.
    if (status >= 500) this.telemetry.event('http_error',{ level: 'error',code,correlationId: request.correlationId });
    response.status(status).json({ code,correlationId: request.correlationId ?? randomUUID() });
  }
}
@Controller()
@UseGuards(ProviderGuard)
class FinancialController {
  constructor(@Inject(SERVICES) private readonly services: ReturnType<typeof financialServices>,
    @Inject(QUERIES) private readonly queries: FinancialQueries) {}
  @Post('wallets')
  open(@Body() input: unknown,@Req() req: HttpRequest) { return this.services.openWallet.execute(openInput(input),context(req)); }
  @Get('wallets/:id')
  wallet(@Param('id') id: string) { return this.queries.wallet(id); }
  @Post('wagering/transactions')
  async process(@Body() input: unknown,@Headers('idempotency-key') key: unknown,@Req() req: HttpRequest,@Res({ passthrough: true }) res: HttpResponse) {
    const result = await this.services.process.execute(input,key,context(req)); res.status(resultStatus(result)); return result;
  }
  @Get('wagering/transactions/:id')
  transaction(@Param('id') id: string) { return this.queries.transaction(id); }
  @Get('providers/:providerId/wagering/transactions/:externalId')
  transactionByExternal(@Param('providerId') provider: string,@Param('externalId') external: string) { return this.queries.transactionByExternal(provider,external); }
  @Get('wallets/:id/ledger')
  ledger(@Param('id') id: string,@Query() query: Record<string,unknown>) {
    if (Object.keys(query).some(key => !['cursor','limit'].includes(key))) throw new DomainError('INVALID_PAYLOAD');
    return this.queries.ledger(id,query.cursor,query.limit);
  }
  @Post('wallets/:id/reconciliation')
  async reconciliation(@Param('id') id: string,@Req() req: HttpRequest,@Res({ passthrough: true }) res: HttpResponse) {
    res.status(200); return this.queries.reconcile(id,context(req));
  }
}
@Controller('health')
class ReadinessController {
  constructor(@Inject(READINESS) private readonly check: () => Promise<void>) {}
  @Get('ready')
  async ready() {
    try { await this.check(); return { status: 'ok' }; }
    catch { throw new HttpException('INFRASTRUCTURE_UNAVAILABLE',503); }
  }
}
@Controller('metrics')
class ReconciliationMetricsController {
  constructor(@Inject(METRICS) private readonly metrics: MetricsCollector) {}
  @Get()
  async metricsText(@Res({ passthrough: true }) res: HttpResponse) {
    res.setHeader('Content-Type','text/plain; version=0.0.4');
    return this.metrics.scrape();
  }
}
export async function createFinancialHttpApp(orm: MikroORM,options: {
  telemetry?: Telemetry; identity?: ProviderIdentityPort; services?: ReturnType<typeof financialServices>; readiness?: () => Promise<void>; onClose?: () => Promise<void>;
} = {}) {
  const telemetry=options.telemetry ?? new PrometheusTelemetry();
  const endpoint = process.env.SQS_ENDPOINT ?? process.env.TEST_SQS_ENDPOINT ?? 'http://127.0.0.1:4567';
  if (!['127.0.0.1','localhost','[::1]','localstack'].includes(new URL(endpoint).hostname)) throw new Error('LOCAL_SQS_ENDPOINT_REQUIRED');
  const sqs = new SQSClient({ endpoint,region: 'us-east-1',credentials: { accessKeyId: 'test',secretAccessKey: 'test' },
    maxAttempts: 1,requestHandler: { requestTimeout: 1500,connectionTimeout: 1000 } });
  const readiness = options.readiness ?? (async () => {
    await Promise.all([orm.em.getConnection().execute('select 1'),sqs.send(new ListQueuesCommand({ MaxResults: 1 }))]);
  });
  const metrics=new MetricsCollector(orm,telemetry,sqs);
  const queries = new MikroFinancialQueries(orm,{ divergence: (walletId,correlationId) => {
    telemetry.count('wager_reconciliation_divergences_total');
    telemetry.event('reconciliation_divergence',{ level: 'warn',code: 'RECONCILIATION_DIVERGENCE',walletId,correlationId });
  } });
  @Module({ controllers: [HealthController,ReadinessController,FinancialController,ReconciliationMetricsController],providers: [
    { provide: SERVICES,useValue: options.services ?? financialServices(orm,undefined,telemetry) },{ provide: QUERIES,useValue: queries },
    { provide: IDENTITY,useValue: options.identity ?? new LocalDevelopmentIdentity() },
    { provide: METRICS,useValue: metrics },{ provide: READINESS,useValue: readiness },ProviderGuard,
    { provide: 'shutdown-resources',useValue: { onApplicationShutdown: async () => { sqs.destroy(); await options.onClose?.(); } } },
  ] })
  class HttpModule {}
  const app = await NestFactory.create(HttpModule,{ logger: false });
  app.use((req: HttpRequest,res: HttpResponse,next: () => void) => {
    const supplied = req.headers['x-correlation-id'];
    req.correlationId = typeof supplied === 'string' && supplied.length <= 200 && supplied.trim() ? supplied : randomUUID();
    res.setHeader('X-Correlation-Id',req.correlationId); next();
  });
  app.useGlobalFilters(new FinancialExceptionFilter(telemetry));
  return app;
}
