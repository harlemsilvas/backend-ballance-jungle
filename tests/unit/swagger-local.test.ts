import { expect,test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const spec=JSON.parse(readFileSync(resolve(__dirname,'../../scripts/swagger/openapi.json'),'utf8'));
test('local Swagger documents all financial, health and metrics routes with unique operations',()=>{
  expect(Object.keys(spec.paths)).toHaveLength(10);
  const ids=Object.values(spec.paths).flatMap((path:any)=>Object.values(path).map((op:any)=>op.operationId));
  expect(new Set(ids).size).toBe(ids.length);
  expect(spec.servers).toEqual([{url:'/',description:'Mesma API local que serve esta documentação'}]);
});
test('Swagger keeps money textual, idempotency required and business statuses distinct',()=>{
  expect(spec.components.schemas.Money.properties.amount.type).toBe('string');
  expect(spec.components.schemas.WagerRequest.properties.kind.enum).not.toContain('OPENING');
  const operation=spec.paths['/wagering/transactions'].post;
  expect(operation.parameters.find((p:any)=>p.name==='Idempotency-Key').required).toBe(true);
  for(const status of ['200','202','400','409','422','503'])expect(operation.responses[status]).toBeDefined();
});
test('experimental Swagger entrypoint refuses production before opening any database',async()=>{
  const child=Bun.spawn([process.execPath,'scripts/swagger/main.ts'],{env:{...process.env,NODE_ENV:'production',AUTH_MODE:'local-development',FINANCIAL_API_ENABLED:'true'},stdout:'pipe',stderr:'pipe'});
  const [status,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(status).toBe(1);expect(stderr).toContain('LOCAL_SWAGGER_STARTUP_FAILED');
},10000);
