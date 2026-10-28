import { test,expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { localSqsClient } from '../../src/infrastructure/messaging/local-sqs';
import { timeout } from '../../scripts/load/shared';

test('load runner interrupt drains active processes and removes only its own schema, login and queues',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'bb-load-check-'));
  const output=join(directory,'results');
  const orm=await MikroORM.init(persistenceConfig()),sqs=localSqsClient();
  const sentinel=`bb_test_sentinel_${randomUUID().replaceAll('-','')}`;
  let child:ReturnType<typeof Bun.spawn>|undefined;
  let reading:Promise<void>|undefined;
  try{
    await orm.em.getConnection().execute(`create schema "${sentinel}"`);
    child=Bun.spawn([process.execPath,'scripts/load/run.ts'],{env:{...process.env,LOAD_CONFIRM:'isolated',DB_HOST:process.env.DB_HOST??'127.0.0.1',DB_PORT:process.env.DB_PORT??'5546',
      LOAD_HISTORIES:'2',LOAD_REQUESTS:'1000',LOAD_OUTPUT:output},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
    let ready!:(schema:string)=>void;
    const measuring=new Promise<string>(resolve=>{ready=resolve;});
    const processChild=child;
    reading=(async()=>{
      const reader=(processChild.stdout as ReadableStream<Uint8Array>).getReader();let buffer='';
      while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=new TextDecoder().decode(chunk.value);
        let end:number;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.startsWith('{'))continue;
          const value=JSON.parse(line) as {event:string;schema:string};if(value.event==='load_measurement_start')ready(value.schema);
        }
      }
    })();
    const schema=await timeout(Promise.race([measuring,child.exited.then(()=>{throw new Error('LOAD_TEST_START_FAILED');})]),20000);
    child.kill('SIGTERM');
    expect(await timeout(child.exited,20000)).toBe(1);await reading;
    const error=await new Response(child.stderr as ReadableStream<Uint8Array>).text();expect(error).toContain('LOAD_INTERRUPTED');
    const suffix=schema.slice('bb_test_'.length);
    const [state]=await orm.em.getConnection().execute<{schemaGone:boolean;roleGone:boolean;sentinelPresent:boolean}[]>(`select
      not exists(select 1 from pg_namespace where nspname=?) as "schemaGone",
      not exists(select 1 from pg_roles where rolname=?) as "roleGone",
      exists(select 1 from pg_namespace where nspname=?) as "sentinelPresent"`,[schema,'bb_load_'+suffix,sentinel]);
    expect(state).toEqual({schemaGone:true,roleGone:true,sentinelPresent:true});
    for(const kind of ['commands','dlq','events'])await expect(sqs.send(new GetQueueUrlCommand({QueueName:`bb-test-${suffix}-${kind}.fifo`}))).rejects.toThrow();
    expect(await Bun.file(join(output,'summary.json')).exists()).toBe(false);
  }finally{
    if(child&&child.exitCode===null){child.kill('SIGKILL');await child.exited;}await reading;
    await orm.em.getConnection().execute(`drop schema if exists "${sentinel}"`);await orm.close(true);sqs.destroy();
    await rm(directory,{recursive:true,force:true});
  }
},45000);

test('population budget records audited partial progress and never presents it as a completed measurement',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'bb-load-budget-'));
  const output=join(directory,'results');
  const orm=await MikroORM.init(persistenceConfig()),sqs=localSqsClient();
  let child:ReturnType<typeof Bun.spawn>|undefined;
  try{
    child=Bun.spawn([process.execPath,'scripts/load/run.ts'],{env:{...process.env,LOAD_CONFIRM:'isolated',DB_HOST:process.env.DB_HOST??'127.0.0.1',DB_PORT:process.env.DB_PORT??'5546',
      LOAD_HISTORIES:'1000',LOAD_REQUESTS:'6',LOAD_REPEATS:'1',LOAD_SHAPES:'hot',LOAD_TRANSPORTS:'http',LOAD_SEED_BUDGET_MS:'1',LOAD_OUTPUT:output},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
    const stdout=new Response(child.stdout as ReadableStream<Uint8Array>).text();
    const stderr=new Response(child.stderr as ReadableStream<Uint8Array>).text();
    expect(await timeout(child.exited,15000)).toBe(1);
    const lines=(await stdout).split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
    const schema=lines.find(line=>line.event==='load_case_start')?.schema as string;
    expect(schema).toMatch(/^bb_test_[a-f0-9]{32}$/);
    expect(await stderr).toContain('LOAD_SEED_BUDGET_EXCEEDED');
    const files:string[]=[];for await(const name of new Bun.Glob('*-population-limit.json').scan(output))files.push(name);
    expect(files).toHaveLength(1);
    const progress=await Bun.file(join(output,files[0]!)).json();
    expect(progress.measured).toBe(false);expect(progress.completedEntries).toBeGreaterThan(0);expect(progress.completedEntries).toBeLessThan(1000);
    expect(progress.checks.every((row:{consistent:boolean;expectedBalance:boolean;versionMatches:boolean})=>row.consistent&&row.expectedBalance&&row.versionMatches)).toBe(true);
    expect(await Bun.file(join(output,'summary.json')).exists()).toBe(false);
    const suffix=schema.slice('bb_test_'.length);
    const [state]=await orm.em.getConnection().execute<{schemaGone:boolean;roleGone:boolean}[]>(`select
      not exists(select 1 from pg_namespace where nspname=?) as "schemaGone",
      not exists(select 1 from pg_roles where rolname=?) as "roleGone"`,[schema,'bb_load_'+suffix]);
    expect(state).toEqual({schemaGone:true,roleGone:true});
    for(const kind of ['commands','dlq','events'])await expect(sqs.send(new GetQueueUrlCommand({QueueName:`bb-test-${suffix}-${kind}.fifo`}))).rejects.toThrow();
  }finally{
    if(child&&child.exitCode===null){child.kill('SIGKILL');await child.exited;}
    await orm.close(true);sqs.destroy();await rm(directory,{recursive:true,force:true});
  }
},20000);
