import { randomUUID,randomBytes,createHash } from 'node:crypto';
import { cpus,totalmem,platform,arch } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { CreateQueueCommand,DeleteQueueCommand,GetQueueAttributesCommand,SendMessageCommand } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { withFinancialSchema } from '../../tests/support/financial-fixture';
import { financialServices } from '../../src/infrastructure/persistence/financial-services';
import { runtimeGrantSql } from '../../src/infrastructure/persistence/runtime-grants';
import { localSqsClient,localQueueUrl } from '../../src/infrastructure/messaging/local-sqs';
import { distribution,timeout,type WalletTarget,type LoadCommand,type LoadSnapshot } from './shared';

function integer(name:string,fallback:number,min:number,max:number){
  const value=process.env[name]??String(fallback);
  if(!/^\d+$/.test(value)||Number(value)<min||Number(value)>max)throw new Error('INVALID_LOAD_CONFIG');return Number(value);
}
const histories=(process.env.LOAD_HISTORIES??'100,1000').split(',').map(value=>{
  if(!/^\d+$/.test(value)||Number(value)<2||Number(value)>10000)throw new Error('INVALID_LOAD_HISTORY');return Number(value);
});
const requests=integer('LOAD_REQUESTS',120,6,10000),concurrency=integer('LOAD_CONCURRENCY',6,1,100);
const processes=integer('LOAD_PROCESSES',3,3,8),walletCount=integer('LOAD_WALLETS',3,2,100);
const scrapeMs=integer('LOAD_SCRAPE_MS',100,20,60000),repeats=integer('LOAD_REPEATS',1,1,10);
const scrapeIntervals=(process.env.LOAD_SCRAPE_INTERVALS??String(scrapeMs)).split(',').map(value=>{
  if(!/^\d+$/.test(value)||Number(value)<20||Number(value)>60000)throw new Error('INVALID_LOAD_INTERVAL');return Number(value);
});
const seedBudgetMs=integer('LOAD_SEED_BUDGET_MS',0,0,3600000),probeRepeats=integer('LOAD_SQL_PROBE_REPEATS',1,1,20);
const shapes=(process.env.LOAD_SHAPES??'hot,spread').split(',') as ('hot'|'spread')[];
const transports=(process.env.LOAD_TRANSPORTS??'http,sqs').split(',') as ('http'|'sqs')[];
if(shapes.some(v=>!['hot','spread'].includes(v))||transports.some(v=>!['http','sqs'].includes(v))
  ||[histories,scrapeIntervals,shapes,transports].some(values=>new Set<string|number>(values).size!==values.length))throw new Error('INVALID_LOAD_MATRIX');
const output=resolve(process.env.LOAD_OUTPUT??'/tmp/ballance-load-'+randomUUID());
interface Child {process:ReturnType<typeof Bun.spawn>;url:string;pid:number;read:Promise<void>}
interface Attempt {ms:number;status:string;technicalError:boolean}
let interrupted=false;
const interrupt=()=>{interrupted=true;};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
const assertRunning=()=>{if(interrupted)throw new Error('LOAD_INTERRUPTED');};
const pending=new Map<string,{resolve:(status:string)=>void}>();
function command(wallet:WalletTarget):LoadCommand {
  return {key:randomUUID(),messageId:randomUUID(),walletId:wallet.id,body:{providerId:'load-provider',externalTransactionId:randomUUID(),
    playerId:wallet.playerId,walletId:wallet.id,roundId:'load-round',gameId:'synthetic',kind:'BET',money:{amount:'0.01',currency:'BRL'}}};
}
async function waitUntil(check:()=>Promise<boolean>,ms=120000){
  const deadline=performance.now()+ms;while(performance.now()<deadline){assertRunning();if(await check())return;await Bun.sleep(25);}throw new Error('LOAD_DRAIN_TIMEOUT');
}
async function pool<T>(items:T[],work:(item:T,index:number)=>Promise<void>){
  let next=0;const workers=await Promise.allSettled(Array.from({length:Math.min(concurrency,items.length)},async()=>{
    while(next<items.length){assertRunning();const index=next++;await work(items[index]!,index);}
  }));
  const failed=workers.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
}
async function child(env:Record<string,string|undefined>):Promise<Child>{
  const processChild=Bun.spawn([process.execPath,'scripts/load/child.ts'],{env:{...process.env,...env},stdin:'ignore',stdout:'pipe',stderr:'ignore'});
  let ready!:(value:{url:string;pid:number})=>void;
  const handshake=new Promise<{url:string;pid:number}>(resolve=>{ready=resolve;});
  const read=(async()=>{
    const reader=(processChild.stdout as ReadableStream<Uint8Array>).getReader();let buffer='';
    while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=new TextDecoder().decode(chunk.value);
      let end:number;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        if(!line.startsWith('{'))continue;const value=JSON.parse(line) as {kind:string;url:string;pid:number;messageId:string;status:string};
        if(value.kind==='ready')ready(value);
        if(value.kind==='acked')pending.get(value.messageId)?.resolve(value.status);
      }
    }
  })();
  try {
    const info=await timeout(Promise.race([handshake,processChild.exited.then(()=>{throw new Error('LOAD_CHILD_START_FAILED');})]),15000);
    return {process:processChild,...info,read};
  }catch(error){processChild.kill('SIGKILL');await processChild.exited;await read;throw error;}
}
async function stop(child:Child){
  if(child.process.exitCode===null)child.process.kill('SIGTERM');
  try{await timeout(child.process.exited,15000);}catch{child.process.kill('SIGKILL');await child.process.exited;throw new Error('LOAD_CHILD_DRAIN_FAILED');}
  finally{await child.read;}
  if(child.process.exitCode!==0)throw new Error('LOAD_CHILD_EXIT_FAILED');
}
async function collect(url:string){
  const response=await fetch(url+'/metrics',{signal:AbortSignal.timeout(10000)});
  const text=await response.text();
  if(!response.ok||!text.includes('wager_metrics_collection_success{source="database"} 1')||!text.includes('wager_metrics_collection_success{source="sqs"} 1'))throw new Error('LOAD_SCRAPE_FAILED');
}
async function plans(orm:MikroORM,s:string,wallet:string){
  const db=orm.em.getConnection();
  const queries={
    ledger_sum:`select coalesce(sum(case direction when 'CREDIT' then amount else -amount end),0) from ${s}.wallet_ledger where wallet_id=?`,
    transaction_wallet:`select id,status from ${s}.wager_transactions where wallet_id=?`,
    ledger_chain:`select balance_after,sum(case direction when 'CREDIT' then amount else -amount end) over(order by wallet_version rows between unbounded preceding and current row) from ${s}.wallet_ledger where wallet_id=?`,
    status_counts:`select status,count(*) from ${s}.wager_transactions group by status`,
    outbox_pending:`select count(*),min(occurred_at) from ${s}.outbox_messages where published_at is null`,
    ledger_changes:`select count(*) from ${s}.wallet_ledger l join ${s}.wager_transactions t on t.id=l.transaction_id where l.wallet_id=? and t.kind<>'OPENING'`,
    transaction_consistency:`select exists(select 1 from ${s}.wager_transactions t
      join ${s}.wallets w on w.id=t.wallet_id
      left join ${s}.wallet_ledger l on l.transaction_id=t.id and l.wallet_id=t.wallet_id
      left join ${s}.wager_transactions r on r.id=t.reference_transaction_id
      where t.wallet_id=? and (
        ((t.status='PROCESSED' and t.kind<>'LOSS')<>(l.id is not null))
        or(t.status='PROCESSED' and(t.player_id<>w.player_id or t.currency<>w.currency))
        or(l.id is not null and(l.amount<>t.amount or l.currency<>t.currency
          or(t.kind='OPENING' and l.wallet_version<>1) or(t.kind<>'OPENING' and l.wallet_version<2) or l.wallet_version>w.version
          or l.direction<>case when t.kind='BET' then 'DEBIT' when t.kind='ROLLBACK' then case when r.kind='BET' then 'CREDIT' else 'DEBIT' end else 'CREDIT' end))
        or(t.status='PROCESSED' and t.reference_transaction_id is not null and(
          r.id is null or r.status<>'PROCESSED' or r.provider_id<>t.provider_id or r.external_transaction_id<>t.reference_external_transaction_id
          or r.wallet_id<>t.wallet_id or r.player_id<>t.player_id or r.currency<>t.currency or r.round_id<>t.round_id
          or(t.kind in('REFUND','WIN') and r.kind<>'BET') or(t.kind='ROLLBACK' and r.kind not in('BET','WIN','REFUND'))
          or(t.kind in('REFUND','ROLLBACK') and r.amount<>t.amount)))
      ))`,
  };
  const result:Record<string,unknown>={};
  for(const [name,query] of Object.entries(queries)){
    const records:unknown[]=[];
    for(let i=0;i<probeRepeats;i++)records.push(...await db.execute<unknown[]>('explain (analyze,buffers,format json) '+query,query.includes('?')?[wallet]:[]));
    result[name]=records;
  }
  return result;
}
async function scenario(history:number,shape:'hot'|'spread',transport:'http'|'sqs',intervalMs:number,repeat:number){
  let report:unknown;
  await withFinancialSchema(async(orm,schema,s)=>{
    assertRunning();
    const scrapes=intervalMs>0;
    const label=`h${history}-${shape}-${transport}-${scrapes?`scrape${intervalMs}`:'off'}-r${repeat}`;
    console.log(JSON.stringify({event:'load_case_start',label,schema}));
    const suffix=schema.slice('bb_test_'.length);
    const role='bb_load_'+suffix,password=randomBytes(24).toString('hex');
    const db=orm.em.getConnection(),client=localSqsClient(),queues:string[]=[],children:Child[]=[];
    let roleCreated=false;
    try{
      await orm.em.fork().transactional(async em=>{
        await em.execute("select set_config('ballance_load.password',?,true)",[password]);
        await em.execute(`do $$ begin execute format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls','${role}',current_setting('ballance_load.password')); end $$`);
      });roleCreated=true;
      for(const sql of runtimeGrantSql(schema,role))await db.execute(sql);
      const names={source:`bb-test-${suffix}-commands.fifo`,dlq:`bb-test-${suffix}-dlq.fifo`,events:`bb-test-${suffix}-events.fifo`};
      const create=async(name:string)=>{await client.send(new CreateQueueCommand({QueueName:name,Attributes:{FifoQueue:'true'}}));const url=await localQueueUrl(client,name);queues.push(url);return url;};
      const source=await create(names.source),dlq=await create(names.dlq);await create(names.events);
      const services=financialServices(orm),wallets:WalletTarget[]=[];
      const seedStart=performance.now();
      for(let n=0;n<(shape==='hot'?1:walletCount);n++){
        const wallet=await services.openWallet.execute({playerId:randomUUID(),initialBalance:{amount:'1000000.00',currency:'BRL'}});wallets.push(wallet);
        for(let i=1;i<history;i++){
          assertRunning();
          if(seedBudgetMs&&performance.now()-seedStart>=seedBudgetMs){
            const elapsedAtLimit=performance.now()-seedStart;
            const checks=await db.execute<{entries:number;consistent:boolean;versionMatches:boolean;expectedBalance:boolean}[]>(`select count(l.id)::int as entries,
              w.balance=coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end),0) as consistent,
              w.version=count(l.id) as "versionMatches",w.balance=1000000.00::numeric-(count(l.id)-1)*0.01::numeric as "expectedBalance"
              from ${s}.wallets w left join ${s}.wallet_ledger l on l.wallet_id=w.id group by w.id`);
            if(checks.some(row=>!row.consistent||!row.versionMatches||!row.expectedBalance))throw new Error('LOAD_SEED_INVARIANT_FAILED');
            for(const table of ['wallets','wager_transactions','wallet_ledger','outbox_messages'])await db.execute(`analyze ${s}.${table}`);
            const partialPlans=await plans(orm,s,wallets[0]!.id);
            await Bun.write(join(output,label+'-population-limit.json'),JSON.stringify({label,history,shape,transport,intervalMs,repeat,
              completedAt:new Date().toISOString(),reason:'LOAD_SEED_BUDGET_EXCEEDED',seedBudgetMs,seedMs:elapsedAtLimit,diagnosticsMs:performance.now()-seedStart-elapsedAtLimit,plans:partialPlans,
              walletsStarted:wallets.length,completedEntries:checks.reduce((sum,row)=>sum+row.entries,0),checks,measured:false},null,2));
            throw new Error('LOAD_SEED_BUDGET_EXCEEDED');
          }
          const input=command(wallet);const result=await services.process.execute(input.body,input.key);if(result.status!=='PROCESSED')throw new Error('LOAD_SEED_FAILED');
          if(i%250===0)console.log(JSON.stringify({event:'load_seed_progress',label,wallet:n+1,entries:i+1,elapsedMs:performance.now()-seedStart}));
        }
      }
      const seedMs=performance.now()-seedStart;
      const [dbSettings]=await db.execute(`select version() as version,current_setting('shared_buffers') as shared_buffers,
        current_setting('max_connections') as max_connections,current_setting('synchronous_commit') as synchronous_commit,
        current_setting('fsync') as fsync,current_setting('autovacuum') as autovacuum`);
      for(const table of ['wallets','wager_transactions','wallet_ledger','outbox_messages'])await db.execute(`analyze ${s}.${table}`);
      const beforePlans=await plans(orm,s,wallets[0]!.id);
      // Sequential startup plus readiness barrier prevents orphan children on partial startup failure.
      for(let i=0;i<processes;i++)children.push(await child({DB_SCHEMA:schema,DB_USER:role,DB_PASSWORD:password,LOAD_QUEUE:names.source,LOAD_EVENTS:names.events,WAGER_DLQ_NAME:names.dlq}));
      const drain=()=>waitUntil(async()=>{const [row]=await db.execute<{count:number}[]>(`select count(*)::int as count from ${s}.outbox_messages where published_at is null`);return row?.count===0;});
      await drain();
      const expected=new Map(wallets.map(w=>[w.id,history]));
      const invoke=async(input:LoadCommand,index:number):Promise<Attempt>=>{
        const start=performance.now();let status='TECHNICAL_ERROR',technicalError=false;
        try{
          if(transport==='http'){
            const response=await fetch(children[index%children.length]!.url+'/wagering/transactions',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':input.key},body:JSON.stringify(input.body),signal:AbortSignal.timeout(120000)});
            const result=await response.json() as {status?:string};status=result.status??'TECHNICAL_ERROR';technicalError=![200,202,422].includes(response.status);
          }else{
            let complete!:(status:string)=>void;const ack=new Promise<string>(resolve=>{complete=resolve;});pending.set(input.messageId,{resolve:complete});
            try{
              await client.send(new SendMessageCommand({QueueUrl:source,MessageGroupId:input.walletId,MessageDeduplicationId:input.messageId,
                MessageBody:JSON.stringify({messageId:input.messageId,type:'WagerTransactionRequested',occurredAt:new Date().toISOString(),data:{...input.body,idempotencyKey:input.key}})}));
              status=await timeout(ack,120000);
            }finally{pending.delete(input.messageId);}
          }
        }catch{technicalError=true;}
        if(status==='PROCESSED'&&!technicalError)expected.set(input.walletId,expected.get(input.walletId)!+1);
        return {ms:performance.now()-start,status,technicalError};
      };
      const warmup=Array.from({length:processes*2},(_,i)=>command(wallets[i%wallets.length]!));
      await pool(warmup,async(input,i)=>{const result=await invoke(input,i);if(result.technicalError||result.status!=='PROCESSED')throw new Error('LOAD_WARMUP_FAILED');});await drain();
      for(const c of children)await fetch(c.url+'/__load/reset',{method:'POST'});
      const commands=Array.from({length:requests},(_,i)=>command(wallets[i%wallets.length]!));
      const attempts:Attempt[]=[],scrapeTimes:number[]=[];let scraping=true,scrapeErrors=0;
      const scraper=scrapes?(async()=>{
        while(scraping){const start=performance.now();await Promise.all(children.map(async c=>{const tick=performance.now();try{await collect(c.url);}catch{scrapeErrors++;}scrapeTimes.push(performance.now()-tick);}));if(scraping)await Bun.sleep(Math.max(0,intervalMs-(performance.now()-start)));}
      })():Promise.resolve();
      console.log(JSON.stringify({event:'load_measurement_start',label,schema}));
      const measuredStart=performance.now();let elapsedMs=0;
      try{await pool(commands,async(input,i)=>{attempts.push(await invoke(input,i));});elapsedMs=performance.now()-measuredStart;}finally{scraping=false;await scraper;}
      const snapshots=await Promise.all(children.map(async c=>await(await fetch(c.url+'/__load/stats')).json() as LoadSnapshot));
      const [backlog]=await db.execute<{pending:number;lag:string}[]>(`select count(*)::int as pending,coalesce(greatest(extract(epoch from clock_timestamp()-min(occurred_at)),0),0)::text as lag from ${s}.outbox_messages where published_at is null`);
      const drainStart=performance.now();await drain();const drainMs=performance.now()-drainStart;
      // Replay the first operation after later movements; compare its stored historical result, not current balance.
      const first=commands[0]!;
      const [stored]=await db.execute<{result:Record<string,unknown>}[]>(`select result_snapshot as result from ${s}.wager_transactions where idempotency_key=?`,[first.key]);
      const replayResponse=await fetch(children[0]!.url+'/wagering/transactions',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':first.key},body:JSON.stringify(first.body)});
      const replay=await replayResponse.json() as Record<string,unknown>;
      if(!stored||!replayResponse.ok||replay.idempotentReplay!==true||JSON.stringify(replay.balance)!==JSON.stringify(stored.result.balance)||replay.transactionId!==stored.result.transactionId)throw new Error('LOAD_REPLAY_FAILED');
      const checks=await db.execute<{id:string;balanced:boolean;expectedBalance:boolean;entries:number;version:number}[]>(`select w.id,w.balance=coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end),0) as balanced,
        w.balance=1000000.00::numeric-(count(l.id)-1)*0.01::numeric as "expectedBalance",count(l.id)::int as entries,w.version
        from ${s}.wallets w left join ${s}.wallet_ledger l on l.wallet_id=w.id group by w.id`);
      if(checks.some(row=>!row.balanced||!row.expectedBalance||row.entries!==expected.get(row.id)||row.version!==row.entries))throw new Error('LOAD_INVARIANT_FAILED');
      const [audit]=await db.execute<{transactions:number;ledger:number;inbox:number;pending:number}[]>(`select
        (select count(*)::int from ${s}.wager_transactions) as transactions,(select count(*)::int from ${s}.wallet_ledger) as ledger,
        (select count(*)::int from ${s}.inbox_messages where processed_at is not null) as inbox,
        (select count(*)::int from ${s}.outbox_messages where published_at is null) as pending`);
      const expectedTotal=[...expected.values()].reduce((a,b)=>a+b,0);
      if(!audit||audit.transactions!==expectedTotal||audit.ledger!==expectedTotal||audit.inbox!==(transport==='sqs'?requests+warmup.length:0)||audit.pending!==0)throw new Error('LOAD_AUDIT_FAILED');
      const dlqSize=await client.send(new GetQueueAttributesCommand({QueueUrl:dlq,AttributeNames:['ApproximateNumberOfMessages']}));
      if(Number(dlqSize.Attributes?.ApproximateNumberOfMessages??0)!==0)throw new Error('LOAD_DLQ_NOT_EMPTY');
      const merged=(name:string)=>snapshots.flatMap(snapshot=>snapshot.samples[name]??[]);
      const completed=attempts.filter(a=>!a.technicalError&&a.status==='PROCESSED').length;
      const result={label,completedAt:new Date().toISOString(),history,shape,transport,scrapes,intervalMs,repeat,dbSettings,wallets:wallets.length,processes:children.map(c=>c.pid),seedMs,warmup:warmup.length,
        requests,concurrency,elapsedMs,processed:completed,businessRejected:attempts.filter(a=>a.status==='REJECTED').length,technicalErrors:attempts.filter(a=>a.technicalError).length,
        throughput:completed/(elapsedMs/1000),latencyMs:distribution(attempts.map(a=>a.ms)),lockWaitMs:distribution(merged('wager_wallet_lock_wait_seconds')),
        processingMs:distribution(merged('wager_processing_duration_seconds:process')),scrapeMs:distribution(scrapeTimes),scrapeErrors,backlogAfterMeasurement:backlog,drainMs,
        resources:snapshots.map(snapshot=>({cpuMicros:snapshot.cpuMicros,rssBytes:snapshot.rssBytes})),metrics:snapshots.map(snapshot=>snapshot.metrics),
        plans:beforePlans,audit:{walletsChecked:checks.length,...audit,replay:true,consistent:true},attempts};
      await Bun.write(join(output,label+'.json'),JSON.stringify(result,null,2));
      console.log(JSON.stringify({event:'load_case_complete',label,throughput:result.throughput,p95:result.latencyMs.p95}));
      if(result.technicalErrors||result.businessRejected||scrapeErrors)throw new Error('LOAD_UNHEALTHY_RESULT');
      report=result;
    }finally{
      const cleanup=await Promise.allSettled(children.map(stop));
      const queueCleanup=await Promise.allSettled(queues.map(url=>client.send(new DeleteQueueCommand({QueueUrl:url}))));client.destroy();
      if(roleCreated){
        await db.execute(`revoke all on all tables in schema ${s} from "${role}"`);await db.execute(`revoke all on all functions in schema ${s} from "${role}"`);
        await db.execute(`revoke all on schema ${s} from "${role}"`);await db.execute(`drop role "${role}"`);
      }
      if([...cleanup,...queueCleanup].some(result=>result.status==='rejected'))throw new Error('LOAD_CLEANUP_FAILED');
    }
  });
  return report;
}
async function main(){
  if(process.env.LOAD_CONFIRM!=='isolated'||!['127.0.0.1','localhost'].includes(process.env.DB_HOST??'')||!process.env.DB_PORT)throw new Error('LOAD_ISOLATED_LOCAL_TARGET_REQUIRED');
  const endpoint=new URL(process.env.SQS_ENDPOINT??process.env.TEST_SQS_ENDPOINT??'http://127.0.0.1:4567');
  if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password)throw new Error('LOAD_LOCAL_SQS_REQUIRED');
  await mkdir(output);
  // ZIPs have no .git and the container need not install Git solely for metadata.
  let gitHead: string | null=null,worktreeDirty: boolean | null=null;
  try {
    const revision=Bun.spawnSync(['git','rev-parse','HEAD']);
    const state=Bun.spawnSync(['git','status','--porcelain']);
    if(revision.exitCode===0 && state.exitCode===0){gitHead=revision.stdout.toString().trim();worktreeDirty=state.stdout.length>0;}
  } catch { /* Exact measured file hashes below remain available without Git. */ }
  const results:unknown[]=[];
  const sourceHashes:Record<string,string>={};
  for(const pattern of ['src/**/*.ts','scripts/load/*.ts'])for await(const name of new Bun.Glob(pattern).scan('.'))sourceHashes[name]=createHash('sha256').update(new Uint8Array(await Bun.file(name).arrayBuffer())).digest('hex');
  for(const name of ['package.json','bun.lock','Dockerfile','compose.yaml','tsconfig.json','tests/support/financial-fixture.ts'])sourceHashes[name]=createHash('sha256').update(new Uint8Array(await Bun.file(name).arrayBuffer())).digest('hex');
  const environment={startedAt:new Date().toISOString(),bun:Bun.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),
    sourceHashes,gitHead,worktreeDirty,dbHost:process.env.DB_HOST,dbPort:process.env.DB_PORT,dbName:process.env.DB_NAME??'ballance',
    sqsEndpoint:process.env.SQS_ENDPOINT??process.env.TEST_SQS_ENDPOINT,histories,requests,concurrency,processes,walletCount,scrapeMs,scrapeIntervals,repeats,shapes,transports,seedBudgetMs,probeRepeats,
    sourceImageReferences:[...await Bun.file('compose.yaml').text().then(s=>s.matchAll(/image: (.+)/g))].map(m=>m[1]),bunImage:(await Bun.file('Dockerfile').text()).split('\n')[0]};
  await Bun.write(join(output,'environment.json'),JSON.stringify(environment,null,2));
  for(let repeat=1;repeat<=repeats;repeat++){
    const matrix:{history:number;shape:'hot'|'spread';transport:'http'|'sqs';interval:number}[]=[];
    for(const history of histories)for(const shape of shapes)for(const transport of transports)for(const interval of [0,...scrapeIntervals])matrix.push({history,shape,transport,interval});
    if(repeat%2===0)matrix.reverse();
    for(const point of matrix)results.push(await scenario(point.history,point.shape,point.transport,point.interval,repeat));
  }
  await Bun.write(join(output,'summary.json'),JSON.stringify({environment,results},null,2));
  console.log(JSON.stringify({event:'load_complete',cases:results.length,output}));
}
void main().catch((error:unknown)=>{const code=error instanceof Error&&/^LOAD_[A-Z_]+$/.test(error.message)?error.message:'LOAD_FAILED';console.error(JSON.stringify({event:'load_failed',code,output}));process.exitCode=1;}).finally(()=>{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);});
