import type { Telemetry,LogFields } from '../../application/telemetry';
const status=['PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'];
const definitions: Record<string,{ type: 'counter'|'gauge'|'histogram'; labels: Record<string,string[]> }> = {
  wager_transactions_total: { type: 'counter',labels: { status } },
  wager_transactions_stored: { type: 'gauge',labels: { status } },
  wager_wallets_opened_total: { type: 'counter',labels: {} },
  wager_duplicates_total: { type: 'counter',labels: { layer: ['financial','inbox','inbox_conflict'] } },
  wager_retries_total: { type: 'counter',labels: { component: ['database','consumer','publisher','scheduler'] } },
  wager_dlq_messages_total: { type: 'counter',labels: { reason: ['permanent','exhausted'] } },
  wager_lock_conflicts_total: { type: 'counter',labels: { kind: ['deadlock','timeout','serialization'] } },
  wager_outbox_published_total: { type: 'counter',labels: {} },
  wager_outbox_lag_seconds: { type: 'gauge',labels: {} },
  wager_outbox_pending: { type: 'gauge',labels: {} },
  wager_dlq_visible_messages: { type: 'gauge',labels: {} },
  wager_metrics_collection_success: { type: 'gauge',labels: { source: ['database','sqs'] } },
  wager_metrics_collection_errors_total: { type: 'counter',labels: { source: ['database','sqs'] } },
  wager_reference_claims_total: { type: 'counter',labels: { outcome: ['claimed','completed','lost','error','released'] } },
  wager_reconciliation_divergences_total: { type: 'counter',labels: {} },
  wager_processing_duration_seconds: { type: 'histogram',labels: { operation: ['open_wallet','process','resume'] } },
  wager_wallet_lock_wait_seconds: { type: 'histogram',labels: {} },
};
const fields=new Set(['correlationId','messageId','transactionId','walletId','providerId','eventId','status','code','attempt','component','outcome','level']);
const buckets=[0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2.5,5,10];
interface Series { name: string; labels: Record<string,string>; value: number; sum: number; count: number; buckets: number[] }
export class PrometheusTelemetry implements Telemetry {
  private series=new Map<string,Series>();
  constructor(private readonly write: (line: string) => void = line => console.log(line)) {
    for (const [name,definition] of Object.entries(definitions)) {
      const keys=Object.keys(definition.labels);
      const initialize=(index: number,labels: Record<string,string>) => {
        if (index===keys.length) { this.get(name,labels); return; }
        const key=keys[index]!; for (const value of definition.labels[key]!) initialize(index+1,{ ...labels,[key]: value });
      };
      initialize(0,{});
    }
  }
  event(event: string,input: LogFields = {}): void {
    const safe: LogFields={ timestamp: new Date().toISOString(),level: 'info',event,
      correlationId: null,messageId: null,transactionId: null,walletId: null,providerId: null };
    for (const [key,value] of Object.entries(input)) {
      if (key==='level' && !['info','warn','error'].includes(String(value))) continue;
      if (fields.has(key) && (typeof value==='string'||typeof value==='number'||value===null)) safe[key]=typeof value==='string'?value.slice(0,256):value;
    }
    try { this.write(JSON.stringify(safe)); } catch { /* Telemetry must not change financial results. */ }
  }
  private get(name: string,labels: Record<string,string>): Series {
    const definition=definitions[name];
    if (!definition || Object.keys(labels).sort().join(',')!==Object.keys(definition.labels).sort().join(',')
      || Object.entries(labels).some(([key,value]) => !definition.labels[key]?.includes(value))) throw new Error('INVALID_METRIC_SERIES');
    const ordered=Object.fromEntries(Object.entries(labels).sort(([a],[b]) => a.localeCompare(b)));
    const key=name+JSON.stringify(ordered); let series=this.series.get(key);
    if (!series) { series={ name,labels: ordered,value: 0,sum: 0,count: 0,buckets: buckets.map(() => 0) }; this.series.set(key,series); }
    return series;
  }
  count(name: string,labels: Record<string,string> = {},value=1): void {
    if (definitions[name]?.type!=='counter'||!Number.isFinite(value)||value<0) throw new Error('INVALID_COUNTER'); this.get(name,labels).value+=value;
  }
  gauge(name: string,value: number,labels: Record<string,string> = {}): void {
    if (definitions[name]?.type!=='gauge'||!Number.isFinite(value)||value<0) throw new Error('INVALID_GAUGE'); this.get(name,labels).value=value;
  }
  observe(name: string,seconds: number,labels: Record<string,string> = {}): void {
    if (definitions[name]?.type!=='histogram'||!Number.isFinite(seconds)||seconds<0) throw new Error('INVALID_HISTOGRAM');
    const series=this.get(name,labels); series.count++; series.sum+=seconds;
    buckets.forEach((bound,i) => { if (seconds<=bound) series.buckets[i]=(series.buckets[i] ?? 0)+1; });
  }
  render(): string {
    const format=(labels: Record<string,string>) => Object.keys(labels).length ? '{'+Object.entries(labels).map(([k,v]) => k+'='+JSON.stringify(v)).join(',')+'}' : '';
    const lines: string[]=[];
    for (const [name,definition] of Object.entries(definitions)) {
      lines.push(`# TYPE ${name} ${definition.type}`);
      for (const series of this.series.values()) {
        if (series.name!==name) continue;
        if (definition.type!=='histogram') lines.push(`${name}${format(series.labels)} ${series.value}`);
        else {
          buckets.forEach((bound,i) => lines.push(`${name}_bucket${format({ ...series.labels,le: String(bound) })} ${series.buckets[i]}`));
          lines.push(`${name}_bucket${format({ ...series.labels,le: '+Inf' })} ${series.count}`);
          lines.push(`${name}_sum${format(series.labels)} ${series.sum}`,`${name}_count${format(series.labels)} ${series.count}`);
        }
      }
    }
    return lines.join('\n')+'\n';
  }
}
