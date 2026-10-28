import { ListQueuesCommand } from '@aws-sdk/client-sqs';
import type { INestApplication } from '@nestjs/common';
import { PrometheusTelemetry } from '../infrastructure/observability/telemetry';
import { MetricsCollector } from '../infrastructure/observability/metrics-collector';
import { createWorkerObservability } from '../interfaces/http/worker-observability';
import { ReferenceStore } from '../infrastructure/persistence/reference-store';
import { ReferenceScheduler } from '../infrastructure/messaging/reference-scheduler';
import { MikroORM } from '@mikro-orm/postgresql';
import { persistenceConfig } from '../infrastructure/persistence/mikro-orm.config';
import { assertRuntimeDatabase } from '../infrastructure/persistence/runtime-database-check';
import { financialServices } from '../infrastructure/persistence/financial-services';
import { OutboxStore } from '../infrastructure/persistence/outbox-store';
import { localSqsClient,localQueueUrl } from '../infrastructure/messaging/local-sqs';
import { SqsWagerConsumer } from '../infrastructure/messaging/sqs-wager-consumer';
import { OutboxPublisher } from '../infrastructure/messaging/outbox-publisher';

async function main(): Promise<void> {
  const mode = process.env.WORKER_MODE ?? 'all';
  if (!['consumer','publisher','scheduler','both','all'].includes(mode)) throw new Error('INVALID_WORKER_MODE');
  const metricsPort=Number(process.env.WORKER_METRICS_PORT ?? '9101');
  if (!Number.isInteger(metricsPort)||metricsPort<1||metricsPort>65535) throw new Error('INVALID_WORKER_METRICS_PORT');
  const telemetry=new PrometheusTelemetry(); let metricsApp: INestApplication | undefined;
  const client = localSqsClient(); const orm = await MikroORM.init(persistenceConfig());
  const workers: (SqsWagerConsumer | OutboxPublisher | ReferenceScheduler)[] = [];
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    try { await Promise.all(workers.map(worker => worker.stop())); }
    finally { try { await metricsApp?.close(); } finally { client.destroy(); await orm.close(true); } }
  })();
  const signal = () => { void stop().catch(() => console.error(JSON.stringify({ level: 'error',code: 'WORKER_DRAIN_FAILED' }))); };
  try {
    await assertRuntimeDatabase(orm);
    if (['consumer','both','all'].includes(mode)) workers.push(new SqsWagerConsumer(client,financialServices(orm,undefined,telemetry).process,{ telemetry,
      queueUrl: await localQueueUrl(client,process.env.WAGER_QUEUE_NAME ?? 'wager-transactions.fifo'),
      dlqUrl: await localQueueUrl(client,process.env.WAGER_DLQ_NAME ?? 'wager-transactions-dlq.fifo'),
    }));
    if (['publisher','both','all'].includes(mode)) workers.push(new OutboxPublisher(new OutboxStore(orm),client,{ telemetry,
      queueUrl: await localQueueUrl(client,process.env.EVENT_QUEUE_NAME ?? 'wager-events.fifo'),
    }));
    if (['scheduler','all'].includes(mode)) workers.push(new ReferenceScheduler(new ReferenceStore(orm),financialServices(orm,undefined,telemetry).process,{ telemetry }));
    metricsApp=await createWorkerObservability(new MetricsCollector(orm,telemetry,client),async () => {
      await Promise.all([orm.em.getConnection().execute('select 1'),client.send(new ListQueuesCommand({ MaxResults: 1 }))]);
    });
    await metricsApp.listen(metricsPort,process.env.HTTP_HOST ?? '127.0.0.1');
    process.once('SIGTERM',signal); process.once('SIGINT',signal);
    telemetry.event('workers_started',{ component: mode });
    await Promise.all(workers.map(worker => worker.run()));
  } finally {
    process.removeListener('SIGTERM',signal); process.removeListener('SIGINT',signal);
    await stop();
  }
}
void main().catch(() => { console.error(JSON.stringify({ level: 'error',code: 'WORKER_STARTUP_OR_RUNTIME_FAILED' })); process.exitCode=1; });
