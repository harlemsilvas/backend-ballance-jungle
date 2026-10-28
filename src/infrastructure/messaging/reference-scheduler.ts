import { NOOP_TELEMETRY,type Telemetry } from '../../application/telemetry';
import { DomainError } from '../../domain/domain-error';
import type { ProcessWagerTransaction } from '../../application/financial-use-cases';
import { ReferenceStore,type ReferenceJob } from '../persistence/reference-store';
export class ReferenceScheduler {
  private stopping=false; private batch: Promise<number> | undefined;
  private active: ReferenceJob[]=[];
  constructor(private readonly store: ReferenceStore,private readonly process: ProcessWagerTransaction,
    private readonly options: { batchSize?: number; leaseMs?: number; telemetry?: Telemetry; afterClaim?: () => Promise<void> } = {}) {}
  private get telemetry(): Telemetry { return this.options.telemetry ?? NOOP_TELEMETRY; }
  async tick(): Promise<number> {
    if (this.stopping) return 0;
    if (this.batch) throw new Error('SCHEDULER_ALREADY_RUNNING');
    const work=this.work(); this.batch=work; try { return await work; } finally { this.batch=undefined; }
  }
  private async work(): Promise<number> {
    const claims=await this.store.claim(this.options.batchSize ?? 10,this.options.leaseMs ?? 30000); this.active=claims;
    this.telemetry.count('wager_reference_claims_total',{ outcome: 'claimed' },claims.length);
    try {
      await this.options.afterClaim?.();
      const results=await Promise.allSettled(claims.map(async claim => {
        if (this.stopping) { if (await this.store.release(claim)) this.telemetry.count('wager_reference_claims_total',{ outcome: 'released' }); return 0; }
        try {
          await this.process.resume(claim.transactionId,{ correlationId: claim.transactionId,causationId: claim.transactionId },claim);
          await this.store.release(claim);
          this.telemetry.count('wager_reference_claims_total',{ outcome: 'completed' });
          this.telemetry.event('reference_completed',{ transactionId: claim.transactionId,walletId: claim.walletId,providerId: claim.providerId,
            correlationId: claim.transactionId,component: 'scheduler' }); return 1;
        } catch (error) {
          const lost=error instanceof DomainError && error.code==='REFERENCE_CLAIM_LOST';
          this.telemetry.count('wager_reference_claims_total',{ outcome: lost?'lost':'error' });
          if (!lost) this.telemetry.count('wager_retries_total',{ component: 'scheduler' });
          this.telemetry.event('reference_retry',{ transactionId: claim.transactionId,walletId: claim.walletId,providerId: claim.providerId,
            correlationId: claim.transactionId,component: 'scheduler',code: lost?'REFERENCE_CLAIM_LOST':'REFERENCE_PROCESSING_FAILURE',level: 'warn' });
          if (!lost) await this.store.release(claim,Math.min(300000,1000*2**Math.min(claim.claims-1,20)));
          return 0;
        }
      }));
      return results.reduce((sum,result) => sum+(result.status==='fulfilled'?result.value:0),0);
    } finally { this.active=[]; }
  }
  async run(): Promise<void> {
    while (!this.stopping) {
      try { if (await this.tick()===0) await new Promise(resolve => setTimeout(resolve,100)); }
      catch { if (!this.stopping) {
        this.telemetry.event('scheduler_poll_failed',{ code: 'REFERENCE_SCHEDULER_RETRY',component: 'scheduler',level: 'error' });
        await new Promise(resolve => setTimeout(resolve,250));
      } }
    }
  }
  async stop(graceMs=5000): Promise<void> {
    this.stopping=true; if (!this.batch) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const done=await Promise.race([this.batch.then(() => true,() => true),new Promise<false>(resolve => { timer=setTimeout(() => resolve(false),graceMs); })]);
      if (!done) await Promise.all(this.active.map(async claim => {
        if (await this.store.release(claim)) this.telemetry.count('wager_reference_claims_total',{ outcome: 'released' });
      }));
    } finally { if (timer) clearTimeout(timer); }
  }
}
