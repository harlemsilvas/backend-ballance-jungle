import { MikroORM } from '@mikro-orm/postgresql';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { financialServices } from '../../src/infrastructure/persistence/financial-services';
import { localSqsClient } from '../../src/infrastructure/messaging/local-sqs';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { OutboxStore } from '../../src/infrastructure/persistence/outbox-store';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
async function main(): Promise<void> {
  const [schema,mode,queueUrl,dlqUrl] = process.argv.slice(2);
  if (!schema || !/^bb_test_[a-f0-9]{32}$/.test(schema) || !queueUrl) throw new Error('ISOLATED_SCHEMA_REQUIRED');
  const orm = await MikroORM.init({ ...persistenceConfig(),schema }); const client = localSqsClient();
  const block = () => new Response(Bun.stdin.stream()).text().then(() => {});
  try {
    if (mode === 'consumer' && dlqUrl) {
      await new SqsWagerConsumer(client,financialServices(orm).process,{ queueUrl,dlqUrl,visibilitySeconds: 1,
        afterCommit: async () => { console.log('COMMITTED'); await block(); } }).pollOnce();
    } else if (mode === 'publisher') {
      await new OutboxPublisher(new OutboxStore(orm),client,{ queueUrl,batchSize: 1,leaseMs: 1000,
        afterPublish: async claim => { console.log(`PUBLISHED:${claim.id}`); await block(); } }).publishBatch();
    } else throw new Error('INVALID_CHILD_MODE');
  } finally { client.destroy(); await orm.close(true); }
}
void main().catch(() => { console.error('MESSAGING_CHILD_FAILED'); process.exitCode=1; });
