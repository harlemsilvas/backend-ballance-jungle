import 'reflect-metadata';
import { Controller,Get,Inject,Module,Res,HttpException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { MetricsCollector } from '../../infrastructure/observability/metrics-collector';
const METRICS=Symbol('worker-metrics'); const READY=Symbol('worker-ready');
@Controller()
class WorkerObservabilityController {
  constructor(@Inject(METRICS) private readonly metrics: MetricsCollector,@Inject(READY) private readonly readyCheck: () => Promise<void>) {}
  @Get('metrics')
  metricsText(@Res({ passthrough: true }) response: { setHeader(name: string,value: string): void }) {
    response.setHeader('Content-Type','text/plain; version=0.0.4'); return this.metrics.scrape();
  }
  @Get('health/live') live() { return { status: 'ok' }; }
  @Get('health/ready') async ready() {
    try { await this.readyCheck(); return { status: 'ok' }; } catch { throw new HttpException({ code: 'INFRASTRUCTURE_UNAVAILABLE' },503); }
  }
}
export async function createWorkerObservability(metrics: MetricsCollector,ready: () => Promise<void>) {
  @Module({ controllers: [WorkerObservabilityController],providers: [
    { provide: METRICS,useValue: metrics },{ provide: READY,useValue: ready },
  ] }) class WorkerObservabilityModule {}
  return NestFactory.create(WorkerObservabilityModule,{ logger: false });
}
