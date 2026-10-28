import { NOOP_TELEMETRY,type Telemetry } from '../../application/telemetry';
import { SQSClient,SendMessageCommand } from '@aws-sdk/client-sqs';
import { OutboxStore,type OutboxClaim } from '../persistence/outbox-store';
export class OutboxPublisher {
  private stopping = false;
  private readonly active = new Map<string,{ claim: OutboxClaim; owned: boolean }>();
  private batch: Promise<number> | undefined;
  constructor(private readonly store: OutboxStore,private readonly client: SQSClient,
    private readonly options: { queueUrl: string; batchSize?: number; leaseMs?: number; telemetry?: Telemetry; afterPublish?: (claim: OutboxClaim) => Promise<void> }) {}
  private get telemetry(): Telemetry { return this.options.telemetry ?? NOOP_TELEMETRY; }
  async publishBatch(): Promise<number> {
    if (this.stopping) return 0;
    if (this.batch) throw new Error('PUBLISHER_ALREADY_RUNNING');
    const work = this.work(); this.batch = work;
    try { return await work; } finally { this.batch = undefined; }
  }
  private async work(): Promise<number> {
    const leaseMs = this.options.leaseMs ?? 30000;
    const claims = await this.store.claim(this.options.batchSize ?? 10,leaseMs);
    const results = await Promise.allSettled(claims.map(async claim => {
      const state = { claim,owned: !this.stopping }; this.active.set(claim.id,state);
      if (!state.owned) { await this.store.release(claim); this.active.delete(claim.id); return 0; }
      const timer = setInterval(() => {
        if (state.owned) void this.store.renew(claim,leaseMs).then(owned => { state.owned=owned; },() => { state.owned=false; });
      },Math.max(50,Math.floor(leaseMs/3))); timer.unref();
      try {
        try {
          const fifo = new URL(this.options.queueUrl).pathname.endsWith('.fifo');
          await this.client.send(new SendMessageCommand({ QueueUrl: this.options.queueUrl,MessageBody: JSON.stringify(claim.payload),
            ...(fifo ? { MessageGroupId: claim.aggregateId,MessageDeduplicationId: claim.id } : {}) }));
        } catch {
          this.telemetry.count('wager_retries_total',{ component: 'publisher' });
          this.telemetry.event('outbox_retry',{ eventId: claim.id,walletId: claim.aggregateId,attempt: claim.attempts,component: 'publisher',level: 'warn' });
          if (state.owned) await this.store.retry(claim,Math.min(300000,1000*2 ** Math.min(claim.attempts-1,20) + Math.floor(Math.random()*250)));
          return 0;
        }
        // Broker confirmed delivery, but published_at is not yet stored. A crash may duplicate delivery.
        await this.options.afterPublish?.(claim);
        const published=state.owned && await this.store.published(claim);
        if (published) {
          this.telemetry.count('wager_outbox_published_total');
          const data=claim.payload.data && typeof claim.payload.data==='object' ? claim.payload.data as Record<string,unknown> : {};
          this.telemetry.event('outbox_published',{ eventId: claim.id,walletId: claim.aggregateId,transactionId: data.transactionId,
            providerId: data.providerId,correlationId: claim.payload.correlationId,component: 'publisher' });
        }
        return published?1:0;
      } finally { clearInterval(timer); this.active.delete(claim.id); }
    }));
    const errors = results.filter(result => result.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map(result => result.reason),'OUTBOX_BATCH_FAILED');
    return results.reduce((sum,result) => sum + (result.status === 'fulfilled' ? result.value : 0),0);
  }
  async run(): Promise<void> {
    while (!this.stopping) {
      try { if (await this.publishBatch() === 0) await new Promise(resolve => setTimeout(resolve,100)); }
      catch { if (!this.stopping) { this.telemetry.event('outbox_batch_failed',{ level: 'error',code: 'OUTBOX_RETRY',component: 'publisher' }); await new Promise(resolve => setTimeout(resolve,100)); } }
    }
  }
  async stop(graceMs = 5000): Promise<void> {
    this.stopping = true; if (!this.batch) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const finished = await Promise.race([this.batch.then(() => true,() => true),new Promise<false>(resolve => { timer=setTimeout(() => resolve(false),graceMs); })]);
      if (!finished) await Promise.all([...this.active.values()].map(async state => { state.owned=false; await this.store.release(state.claim); }));
    } finally { if (timer) clearTimeout(timer); }
  }
}
