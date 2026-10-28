import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migration } from '@mikro-orm/migrations';
import {
  SQSClient, CreateQueueCommand, GetQueueAttributesCommand, SendMessageCommand,
  ReceiveMessageCommand, DeleteMessageCommand, DeleteQueueCommand,
} from '@aws-sdk/client-sqs';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

// No table or queue belonging to the application is modified by this suite.
test('PostgreSQL: host connection, exact numeric roundtrip and rollback', async () => {
  const orm = await MikroORM.init(persistenceConfig());
  try {
    const rows = await orm.em.getConnection().execute<{ amount: string }[]>(
      'select cast(? as numeric(20,2)) as amount', ['999999999999999999.99'],
    );
    expect(rows[0]?.amount).toBe('999999999999999999.99');
    const table = `bb_probe_${randomUUID().replaceAll('-', '')}`;
    await expect(orm.em.fork().transactional(async em => {
      await em.execute(`create temporary table "${table}" (id integer) on commit drop`);
      await em.execute(`insert into "${table}" values (1)`);
      throw new Error('INJECTED_ROLLBACK');
    })).rejects.toThrow('INJECTED_ROLLBACK');
    const result = await orm.em.getConnection().execute<{ name: string | null }[]>(
      'select to_regclass(?) as name', [table],
    );
    expect(result[0]?.name).toBeNull();
  } finally {
    await orm.close(true);
  }
}, 15000);

test('SQS: host connection, FIFO redelivery and actual redrive to isolated DLQ', async () => {
  const endpoint = process.env.TEST_SQS_ENDPOINT ?? 'http://127.0.0.1:4567';
  const target = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
    throw new Error('Infrastructure tests require a local SQS emulator');
  }
  const client = new SQSClient({
    endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 2,
    requestHandler: { requestTimeout: 5000, connectionTimeout: 2000 },
  });
  const suffix = randomUUID();
  const created: string[] = [];
  // LocalStack may advertise container-internal URLs; all requests use the host endpoint.
  const hostUrl = (url: string): string => {
    const result = new URL(url);
    result.protocol = target.protocol;
    result.host = target.host;
    return result.toString();
  };
  try {
    const dlq = await client.send(new CreateQueueCommand({
      QueueName: `bb-test-${suffix}-dlq.fifo`, Attributes: { FifoQueue: 'true' },
    }));
    if (!dlq.QueueUrl) throw new Error('DLQ URL missing');
    const dlqUrl = hostUrl(dlq.QueueUrl);
    created.push(dlqUrl);
    const attrs = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
    const arn = attrs.Attributes?.QueueArn;
    if (!arn) throw new Error('DLQ ARN missing');
    const source = await client.send(new CreateQueueCommand({
      QueueName: `bb-test-${suffix}.fifo`,
      Attributes: {
        FifoQueue: 'true', VisibilityTimeout: '0',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: '5' }),
      },
    }));
    if (!source.QueueUrl) throw new Error('Source URL missing');
    const sourceUrl = hostUrl(source.QueueUrl);
    created.push(sourceUrl);
    const body = JSON.stringify({ testId: suffix, type: 'InfrastructureProbe' });
    const sent = await client.send(new SendMessageCommand({
      QueueUrl: sourceUrl, MessageBody: body, MessageGroupId: suffix, MessageDeduplicationId: suffix,
    }));
    // Visibility 0 accelerates redelivery without arbitrary sleeps or changes to application queues.
    for (let attempt = 1; attempt <= 5; attempt++) {
      const received = await client.send(new ReceiveMessageCommand({
        QueueUrl: sourceUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }));
      expect(received.Messages).toHaveLength(1);
      expect(received.Messages?.[0]?.MessageId).toBe(sent.MessageId);
      expect(received.Messages?.[0]?.Body).toBe(body);
      expect(received.Messages?.[0]?.Attributes?.ApproximateReceiveCount).toBe(String(attempt));
    }
    // The next receive exceeds maxReceiveCount and triggers broker redrive.
    const sourceAfter = await client.send(new ReceiveMessageCommand({ QueueUrl: sourceUrl, WaitTimeSeconds: 1 }));
    expect(sourceAfter.Messages ?? []).toHaveLength(0);
    const dead = await client.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, WaitTimeSeconds: 2 }));
    expect(dead.Messages).toHaveLength(1);
    expect(dead.Messages?.[0]?.Body).toBe(body);
    const handle = dead.Messages?.[0]?.ReceiptHandle;
    if (!handle) throw new Error('DLQ receipt missing');
    await client.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: handle }));
  } finally {
    // Delete only resources created by this invocation; report cleanup failures.
    const results = await Promise.allSettled(created.map(QueueUrl => client.send(new DeleteQueueCommand({ QueueUrl }))));
    client.destroy();
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Isolated queue cleanup failed');
  }
}, 30000);


test('MikroORM: versioned migrations up/down/up in an isolated schema', async () => {
  const schema = `bb_test_${randomUUID().replaceAll('-', '')}`;
  class MigrationProbe extends Migration {
    override async up(): Promise<void> {
      this.addSql(`create table "${schema}".probe (id integer primary key)`);
    }
    override async down(): Promise<void> {
      this.addSql(`drop table "${schema}".probe`);
    }
  }
  const base = persistenceConfig();
  const orm = await MikroORM.init({
    ...base, schema,
    migrations: {
      ...base.migrations,
      migrationsList: [{ name: 'Migration202610260001', class: MigrationProbe }],
      tableName: `${schema}.mikro_orm_migrations`,
    },
  });
  try {
    await orm.em.getConnection().execute(`create schema "${schema}"`);
    const migrator = orm.getMigrator();
    expect(await migrator.getPendingMigrations()).toHaveLength(1);
    await migrator.up();
    expect(await migrator.getExecutedMigrations()).toHaveLength(1);
    const exists = async () => {
      const rows = await orm.em.getConnection().execute<{ name: string | null }[]>(
        'select to_regclass(?) as name', [`${schema}.probe`],
      );
      return rows[0]?.name != null;
    };
    expect(await exists()).toBe(true);
    await migrator.down();
    expect(await exists()).toBe(false);
    expect(await migrator.getExecutedMigrations()).toHaveLength(0);
    await migrator.up();
    expect(await exists()).toBe(true);
    expect(await migrator.getExecutedMigrations()).toHaveLength(1);
  } finally {
    try { await orm.em.getConnection().execute(`drop schema if exists "${schema}" cascade`); }
    finally { await orm.close(true); }
  }
}, 15000);
