import type { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand,type SQSClient } from '@aws-sdk/client-sqs';
import type { Telemetry } from '../../application/telemetry';
import { localQueueUrl } from '../messaging/local-sqs';
export class MetricsCollector {
  private readonly schema: string;
  constructor(private readonly orm: MikroORM,private readonly telemetry: Telemetry,
    private readonly sqs: SQSClient,private readonly dlqName=process.env.WAGER_DLQ_NAME ?? 'wager-transactions-dlq.fifo') {
    const schema=orm.config.get('schema') ?? 'public';
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('INVALID_METRICS_SCHEMA'); this.schema=`"${schema}"`;
  }
  async scrape(): Promise<string> {
    await Promise.all([this.database(),this.queue()]); return this.telemetry.render();
  }
  private async database(): Promise<void> {
    try {
      const [row]=await this.orm.em.getConnection().execute<{ pending: number; lag: number; statuses: Record<string,number> }[]>(`select
        (select count(*)::float8 from ${this.schema}.outbox_messages where published_at is null) as pending,
        (select coalesce(greatest(extract(epoch from clock_timestamp()-min(occurred_at)),0),0)::float8 from ${this.schema}.outbox_messages where published_at is null) as lag,
        (select coalesce(jsonb_object_agg(status,n),'{}') from (select status,count(*)::float8 as n from ${this.schema}.wager_transactions group by status) counts) as statuses`);
      if (!row) throw new Error('METRICS_QUERY_FAILED');
      this.telemetry.gauge('wager_outbox_pending',row.pending); this.telemetry.gauge('wager_outbox_lag_seconds',row.lag);
      for (const status of ['PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED']) this.telemetry.gauge('wager_transactions_stored',row.statuses[status] ?? 0,{ status });
      this.telemetry.gauge('wager_metrics_collection_success',1,{ source: 'database' });
    } catch { this.telemetry.count('wager_metrics_collection_errors_total',{ source: 'database' }); this.telemetry.gauge('wager_metrics_collection_success',0,{ source: 'database' }); }
  }
  private async queue(): Promise<void> {
    try {
      const queue=await localQueueUrl(this.sqs,this.dlqName);
      const result=await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: queue,AttributeNames: ['ApproximateNumberOfMessages'] }));
      this.telemetry.gauge('wager_dlq_visible_messages',Number(result.Attributes?.ApproximateNumberOfMessages ?? 0));
      this.telemetry.gauge('wager_metrics_collection_success',1,{ source: 'sqs' });
    } catch { this.telemetry.count('wager_metrics_collection_errors_total',{ source: 'sqs' }); this.telemetry.gauge('wager_metrics_collection_success',0,{ source: 'sqs' }); }
  }
}
