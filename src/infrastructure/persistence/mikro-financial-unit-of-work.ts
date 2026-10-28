import { NOOP_TELEMETRY,type Telemetry,type LogFields } from '../../application/telemetry';
import { IsolationLevel, LockMode } from '@mikro-orm/core';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import type { FinancialSession, FinancialUnitOfWork, StoredTransaction, TransactionResult, InboxReceipt, ReferenceClaim } from '../../application/financial-ports';
import type { Wallet } from '../../domain/wallet';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type { IntegrationEvent } from '../../domain/events/integration-event';
import { WalletSchema, WagerTransactionSchema, WalletLedgerSchema, OutboxSchema, InboxSchema, type WagerTransactionRow } from './financial-records';
import { DomainError } from '../../domain/domain-error';
import { WalletMapper } from './wallet-mapper';
import { TransactionMapper, LedgerMapper } from './financial-mappers';

function stored(row: WagerTransactionRow | null): StoredTransaction | undefined {
  if (!row) return undefined;
  return { transaction: TransactionMapper.fromRow(row),
    result: row.resultSnapshot === null ? null : structuredClone(row.resultSnapshot) as unknown as TransactionResult,
    referenceAttempts: row.referenceAttempts, nextReferenceAttemptAt: row.nextReferenceAttemptAt };
}
class MikroFinancialSession implements FinancialSession {
  constructor(private readonly em: EntityManager,private readonly telemetry: Telemetry) {}
  private referenceTable(): string {
    const schema=this.em.config.get('schema') ?? 'public';
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('INVALID_REFERENCE_SCHEMA'); return `"${schema}".reference_jobs`;
  }
  async ownReferenceClaim(claim: ReferenceClaim): Promise<boolean> {
    const rows=await this.em.execute(`select transaction_id from ${this.referenceTable()}
      where transaction_id=? and lease_token=? and lease_until>clock_timestamp() for update`,[claim.transactionId,claim.token]);
    return rows.length===1;
  }
  async completeReferenceClaim(claim: ReferenceClaim): Promise<void> {
    await this.em.execute(`update ${this.referenceTable()} set lease_token=null,lease_until=null where transaction_id=? and lease_token=?`,[claim.transactionId,claim.token]);
  }
  async acceptInbox(receipt: InboxReceipt,at: Date): Promise<boolean> {
    if (!receipt.consumerName.trim() || !receipt.messageId.trim() || !/^[a-f0-9]{64}$/.test(receipt.payloadHash)) throw new DomainError('INVALID_INBOX_RECEIPT');
    const key = { consumerName: receipt.consumerName,messageId: receipt.messageId };
    const row = await this.em.findOne(InboxSchema,key,{ lockMode: LockMode.PESSIMISTIC_WRITE,refresh: true });
    if (row) {
      if (row.payloadHash !== receipt.payloadHash) throw new DomainError('INBOX_PAYLOAD_CONFLICT');
      return row.processedAt === null;
    }
    await this.em.persistAndFlush(this.em.create(InboxSchema,{ ...receipt,receivedAt: at,processedAt: null }));
    return true;
  }
  async completeInbox(receipt: InboxReceipt,at: Date): Promise<void> {
    await this.em.nativeUpdate(InboxSchema,{ consumerName: receipt.consumerName,messageId: receipt.messageId },{ processedAt: at });
  }
  async lockWallet(id: string): Promise<Wallet | undefined> {
    const started=performance.now();
    try {
      const row = await this.em.findOne(WalletSchema,{ id },{ lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
      return row ? WalletMapper.fromRow(row) : undefined;
    } finally { this.telemetry.observe('wager_wallet_lock_wait_seconds',(performance.now()-started)/1000); }
  }
  async findWalletByOwner(playerId: string, currency: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletSchema,{ playerId,currency },{ refresh: true });
    return row ? WalletMapper.fromRow(row) : undefined;
  }
  async insertWallet(wallet: Wallet): Promise<void> {
    await this.em.persistAndFlush(this.em.create(WalletSchema,WalletMapper.toRow(wallet)));
  }
  async saveWallet(wallet: Wallet): Promise<void> {
    await this.em.nativeUpdate(WalletSchema,{ id: wallet.id },{ balance: wallet.balance.toJSON().amount,version: wallet.version,updatedAt: wallet.updatedAt });
  }
  async findTransactionByKey(idempotencyKey: string) { return stored(await this.em.findOne(WagerTransactionSchema,{ idempotencyKey },{ refresh: true })); }
  async findTransactionById(id: string) { return stored(await this.em.findOne(WagerTransactionSchema,{ id },{ refresh: true })); }
  async findTransactionByExternal(providerId: string, externalTransactionId: string) {
    return stored(await this.em.findOne(WagerTransactionSchema,{ providerId,externalTransactionId },{ refresh: true }));
  }
  async hasSuccessfulReversal(referenceTransactionId: string, kind: string): Promise<boolean> {
    return !!await this.em.findOne(WagerTransactionSchema,{ referenceTransactionId,kind,status: 'PROCESSED' },{ refresh: true });
  }
  async saveTransaction(tx: WagerTransaction, result: TransactionResult | null, existing: boolean, attempts: number, nextAttempt: Date | null): Promise<void> {
    const row = { ...TransactionMapper.toRow(tx), resultSnapshot: result === null ? null : { ...result },
      referenceAttempts: attempts, nextReferenceAttemptAt: nextAttempt };
    if (existing) await this.em.nativeUpdate(WagerTransactionSchema,{ id: tx.id },{
      status: row.status,failureCode: row.failureCode,processedAt: row.processedAt,
      referenceTransactionId: row.referenceTransactionId,resultSnapshot: row.resultSnapshot,
      referenceAttempts: row.referenceAttempts,nextReferenceAttemptAt: row.nextReferenceAttemptAt,
    });
    else await this.em.persistAndFlush(this.em.create(WagerTransactionSchema,row));
  }
  async appendLedger(entry: WalletLedgerEntry, version: number): Promise<void> {
    await this.em.persistAndFlush(this.em.create(WalletLedgerSchema,LedgerMapper.toRow(entry,version)));
  }
  async enqueue(event: IntegrationEvent<unknown>): Promise<void> {
    await this.em.persistAndFlush(this.em.create(OutboxSchema,{
      id: event.eventId, aggregateId: event.aggregateId, eventType: event.eventType,
      payload: { ...event.toJSON() }, occurredAt: event.occurredAt, attempts: 0,
      nextAttemptAt: null, publishedAt: null, leaseToken: null, leaseUntil: null,
    }));
  }
}
function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as { code?: string; cause?: unknown };
  return value.code ?? (value.cause === error ? undefined : sqlState(value.cause));
}
export class MikroFinancialUnitOfWork implements FinancialUnitOfWork {
  constructor(private readonly orm: MikroORM,private readonly telemetry: Telemetry=NOOP_TELEMETRY,
    private readonly options: { lockTimeoutMs?: number } = {}) {
    const timeout=options.lockTimeoutMs ?? 5000;
    if (!Number.isInteger(timeout)||timeout<1||timeout>60000) throw new Error('INVALID_LOCK_TIMEOUT');
  }
  async run<T>(work: (session: FinancialSession) => Promise<T>,ctx: LogFields = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.orm.em.fork().transactional(async em => {
          await em.execute("select set_config('lock_timeout',?,true)",[`${this.options.lockTimeoutMs ?? 5000}ms`]);
          return work(new MikroFinancialSession(em,this.telemetry));
        },{ isolationLevel: IsolationLevel.READ_COMMITTED });
      } catch (error) {
        // Entire transaction has rolled back. Re-read winning identities on a fresh attempt.
        const code=sqlState(error);
        if (code && ['40P01','55P03','40001'].includes(code)) this.telemetry.count('wager_lock_conflicts_total',{
          kind: code==='40P01'?'deadlock':code==='55P03'?'timeout':'serialization',
        });
        if (attempt >= 3 || !['23505','40001','40P01','55P03'].includes(code ?? '')) throw error;
        this.telemetry.count('wager_retries_total',{ component: 'database' });
        this.telemetry.event('database_retry',{ ...ctx,code,attempt: attempt+1,component: 'database' });
        await new Promise(resolve => setTimeout(resolve,5 * 2 ** attempt + Math.floor(Math.random() * 5)));
      }
    }
  }
}
