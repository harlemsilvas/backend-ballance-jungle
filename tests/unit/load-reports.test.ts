import { expect,test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
interface Row { sequence:string; shape:string; transport:string; throughput:number|null; p95:number|null; history:number|null }
interface Report { name:string; rows:Row[]; limits:unknown[] }
const context:{ReportModel?:{normalize:(report:unknown,name?:string)=>Report;filter:(rows:Row[],filters:Record<string,string>)=>Row[]}}={};
runInNewContext(readFileSync(resolve(__dirname,'../../scripts/reports/model.js'),'utf8'),context);
const model=context.ReportModel!;
const historical=JSON.parse(readFileSync(resolve(__dirname,'../../docs/benchmarks/results-002.json'),'utf8'));
test('load dashboard preserves individual measured scenarios and exact percentiles',()=>{
  const report=model.normalize(historical);
  expect(report.rows).toHaveLength(48);
  expect(report.rows[0]!.p95).toBe(historical.results[0].latencyMs.p95);
  expect(report.rows[0]!.throughput).toBe(historical.results[0].throughput);
});
test('population limit has no invented measured throughput',()=>{
  const report=model.normalize({sequence:'003',results:[],populationLimits:[{completedEntries:7977,measured:false}]});
  expect(report.rows).toHaveLength(0);expect(report.limits).toHaveLength(1);
});
test('missing or invalid measurements remain unknown, not healthy zero',()=>{
  const report=model.normalize({results:[{throughput:null,latencyMs:{p95:-1}}]});
  expect(report.rows[0]!.throughput).toBeNull();expect(report.rows[0]!.p95).toBeNull();
  expect(()=>model.normalize({results:'invalid'})).toThrow();
});
test('filters isolate HTTP hot history 1000 without combining repetitions',()=>{
  const rows=model.filter(model.normalize(historical).rows,{history:'1000',shape:'hot',transport:'http'});
  expect(rows).toHaveLength(6);
  expect(rows.every(r=>r.history===1000&&r.shape==='hot'&&r.transport==='http')).toBe(true);
  expect(model.filter(rows,{query:'scrape5000-r2'})).toHaveLength(1);
});
