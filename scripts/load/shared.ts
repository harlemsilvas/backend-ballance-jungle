import type { Telemetry,LogFields } from '../../src/application/telemetry';
import { PrometheusTelemetry } from '../../src/infrastructure/observability/telemetry';
export interface WalletTarget { id: string; playerId: string }
export interface LoadCommand {
  key: string; messageId: string; walletId: string;
  body: { providerId: string; externalTransactionId: string; playerId: string; walletId: string;
    roundId: string; gameId: string; kind: 'BET'; money: { amount: string; currency: 'BRL' } };
}
export function distribution(values: number[]) {
  if (!values.length) return {count:0,p50:null,p95:null,p99:null,max:null};
  const sorted=[...values].sort((a,b)=>a-b);
  const percentile=(p:number)=>sorted[Math.max(0,Math.ceil(p*sorted.length)-1)]!;
  return {count:values.length,p50:percentile(.5),p95:percentile(.95),p99:percentile(.99),max:sorted.at(-1)!};
}
export async function timeout<T>(work: Promise<T>,ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('LOAD_TIMEOUT')),ms);})]);}
  finally {if(timer)clearTimeout(timer);}
}
export class LoadTelemetry implements Telemetry {
  private registry=new PrometheusTelemetry(()=>{});
  samples: Record<string,number[]>={};
  private cpu=process.cpuUsage();
  reset(){this.registry=new PrometheusTelemetry(()=>{});this.samples={};this.cpu=process.cpuUsage();}
  snapshot(){return {samples:this.samples,metrics:this.render(),cpuMicros:process.cpuUsage(this.cpu),rssBytes:process.memoryUsage().rss};}
  event(event:string,fields:LogFields={}) {
    if(event==='message_acked') console.log(JSON.stringify({kind:'acked',messageId:fields.messageId,status:fields.status}));
  }
  count(name:string,labels:Record<string,string>={},value=1){this.registry.count(name,labels,value);}
  gauge(name:string,value:number,labels:Record<string,string>={}){this.registry.gauge(name,value,labels);}
  observe(name:string,seconds:number,labels:Record<string,string>={}) {
    this.registry.observe(name,seconds,labels);
    (this.samples[name+(labels.operation?':'+labels.operation:'')]??=[]).push(seconds*1000);
  }
  render(){return this.registry.render();}
}
export type LoadSnapshot=ReturnType<LoadTelemetry['snapshot']>;
