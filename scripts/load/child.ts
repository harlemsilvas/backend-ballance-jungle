import { MikroORM } from '@mikro-orm/postgresql';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { assertRuntimeDatabase } from '../../src/infrastructure/persistence/runtime-database-check';
import { financialServices } from '../../src/infrastructure/persistence/financial-services';
import { OutboxStore } from '../../src/infrastructure/persistence/outbox-store';
import { localSqsClient,localQueueUrl } from '../../src/infrastructure/messaging/local-sqs';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { createFinancialHttpApp } from '../../src/interfaces/http/financial-http';
import { LoadTelemetry } from './shared';

async function main(){
  if(!/^bb_test_[a-f0-9]{32}$/.test(process.env.DB_SCHEMA??''))throw new Error('ISOLATED_SCHEMA_REQUIRED');
  const orm=await MikroORM.init(persistenceConfig());
  const client=localSqsClient();
  const telemetry=new LoadTelemetry();
  let consumer:SqsWagerConsumer|undefined,publisher:OutboxPublisher|undefined;
  let stopping:Promise<void>|undefined;
  let app:Awaited<ReturnType<typeof createFinancialHttpApp>>|undefined;
  const stop=()=>stopping??=(async()=>{
    try {await Promise.all([consumer?.stop(),publisher?.stop()]);await app?.close();}
    finally {client.destroy();await orm.close(true);}
  })();
  const signal=()=>{void stop();};
  try {
    await assertRuntimeDatabase(orm);
    consumer=new SqsWagerConsumer(client,financialServices(orm,undefined,telemetry).process,{
      queueUrl:await localQueueUrl(client,process.env.LOAD_QUEUE!),dlqUrl:await localQueueUrl(client,process.env.WAGER_DLQ_NAME!),telemetry,
    });
    publisher=new OutboxPublisher(new OutboxStore(orm),client,{queueUrl:await localQueueUrl(client,process.env.LOAD_EVENTS!),telemetry});

    app=await createFinancialHttpApp(orm,{telemetry});
    // Test-only control endpoints on an ephemeral loopback listener; never part of the application build.
    app.use((req:{url:string;method:string},res:{json(value:unknown):void},next:()=>void)=>{
      if(req.url==='/__load/stats'){res.json(telemetry.snapshot());return;}
      if(req.url==='/__load/reset'&&req.method==='POST'){telemetry.reset();res.json({ok:true});return;}
      next();
    });
    await app.listen(0,'127.0.0.1');
    console.log(JSON.stringify({kind:'ready',url:await app.getUrl(),pid:process.pid}));
    process.once('SIGTERM',signal);process.once('SIGINT',signal);
    await Promise.all([consumer.run(),publisher.run()]);
  } finally {process.removeListener('SIGTERM',signal);process.removeListener('SIGINT',signal);await stop();}
}
void main().catch(()=>{console.error('LOAD_CHILD_FAILED');process.exitCode=1;});
