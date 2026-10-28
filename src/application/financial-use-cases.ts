import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { DomainError } from '../domain/domain-error';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WagerTransaction, WagerTransactionStatus as Status, type RejectionCode } from '../domain/wager-transaction';
import { WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference, WalletBalanceChanged } from '../domain/events/wager-events';
import type { EventContext } from '../domain/events/integration-event';
import type { FinancialUnitOfWork, FinancialSession, ExecutionEnvironment, RequestContext, StoredTransaction, TransactionResult, InboxReceipt, ReferenceClaim } from './financial-ports';
import { NOOP_TELEMETRY,type Telemetry } from './telemetry';
import { prepareWagerCommand } from './wager-request';

type OperationContext=RequestContext & { walletId?: string; providerId?: string; transactionId?: string; messageId?: string; inboxDuplicate?: boolean };
function uuid(value: string): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new DomainError('INVALID_PAYLOAD');
}
function response(tx: WagerTransaction, wallet: Wallet, replay = false): TransactionResult {
  return { transactionId: tx.id, status: tx.status, balance: wallet.balance.toJSON(), idempotentReplay: replay,
    ...(tx.failureCode === undefined ? {} : { failureCode: tx.failureCode }) };
}
function replay(stored: StoredTransaction): TransactionResult {
  if (!stored.result) throw new Error('MISSING_TERMINAL_RESULT');
  return { ...structuredClone(stored.result), idempotentReplay: true };
}
function context(env: ExecutionEnvironment, request: RequestContext, at: Date): EventContext {
  return { eventId: env.newId(), correlationId: request.correlationId ?? env.newId(), occurredAt: at,
    ...(request.causationId === undefined ? {} : { causationId: request.causationId }) };
}
export class OpenWallet {
  constructor(private readonly uow: FinancialUnitOfWork, private readonly env: ExecutionEnvironment,private readonly telemetry: Telemetry=NOOP_TELEMETRY) {}
  async execute(input: { playerId: string; initialBalance: MoneyProps },request: RequestContext = {}) {
    const started=performance.now(); const ctx: OperationContext={ ...request,correlationId: request.correlationId ?? this.env.newId() };
    try {
      const result=await this.executeCore(input,ctx);
      this.telemetry.count('wager_wallets_opened_total');
      if (result.balance.amount!=='0.00') this.telemetry.count('wager_transactions_total',{ status: 'PROCESSED' });
      this.telemetry.event('wallet_opened',{ ...ctx,walletId: result.id,providerId: '__internal_opening__' }); return result;
    } catch (error) { this.telemetry.event('wallet_open_failed',{ ...ctx,code: error instanceof DomainError?error.code:'PROCESSING_ERROR' }); throw error; }
    finally { this.telemetry.observe('wager_processing_duration_seconds',(performance.now()-started)/1000,{ operation: 'open_wallet' }); }
  }
  private async executeCore(input: { playerId: string; initialBalance: MoneyProps }, request: OperationContext = {}) {
    uuid(input.playerId);
    if (input.initialBalance.currency !== 'BRL') throw new DomainError('UNSUPPORTED_CURRENCY');
    const money = Money.from(input.initialBalance);
    const id = this.env.newId(); const transactionId = this.env.newId(); const entryId = this.env.newId();
    const at = this.env.now(); const correlationId = request.correlationId ?? this.env.newId();
    request.walletId=id; if (money.isPositive()) request.transactionId=transactionId;
    return this.uow.run(async session => {
      if (await session.findWalletByOwner(input.playerId,money.currency)) throw new DomainError('WALLET_ALREADY_EXISTS');
      const { wallet,openingEntry } = Wallet.open({ id,playerId: input.playerId,initialBalance: money,at,
        opening: { transactionId,entryId } });
      await session.insertWallet(wallet);
      if (openingEntry) {
        const tx = WagerTransaction.createOpening({ id: transactionId, providerId: '__internal_opening__',
          externalTransactionId: id, idempotencyKey: `internal:opening:${id}`,
          payloadHash: createHash('sha256').update(JSON.stringify({ walletId: id,playerId: input.playerId,money: money.toJSON() })).digest('hex'),
          walletId: id,playerId: input.playerId,roundId: 'opening',gameId: 'opening',money,createdAt: at });
        tx.markProcessed(undefined,at);
        await session.saveTransaction(tx,response(tx,wallet),false,0,null);
        await session.appendLedger(openingEntry,1);
        await session.enqueue(WagerTransactionProcessed.from(tx,context(this.env,{ ...request,correlationId },at)));
        await session.enqueue(WalletBalanceChanged.from(wallet,openingEntry,context(this.env,{ ...request,correlationId },at)));
      }
      return { id: wallet.id,playerId: wallet.playerId,balance: wallet.balance.toJSON(),version: wallet.version };
    },{ ...request });
  }
}
const rejectionCodes = new Set<RejectionCode>(['PLAYER_MISMATCH','CURRENCY_MISMATCH','INSUFFICIENT_FUNDS',
  'REVERSAL_INSUFFICIENT_FUNDS','REFERENCE_MISMATCH','REFERENCE_KIND_INVALID','REFERENCE_NOT_PROCESSED',
  'REFERENCE_EXPIRED','REVERSAL_ALREADY_APPLIED']);
export class ProcessWagerTransaction {
  constructor(private readonly uow: FinancialUnitOfWork, private readonly env: ExecutionEnvironment,private readonly telemetry: Telemetry=NOOP_TELEMETRY) {}
  async execute(input: unknown,key: unknown,request: RequestContext = {},inbox?: InboxReceipt): Promise<TransactionResult> {
    const started=performance.now(); const ctx: OperationContext={ ...request,correlationId: request.correlationId ?? this.env.newId(),...(inbox?{ messageId: inbox.messageId }:{}) };
    try {
      const result=await this.executeCore(input,key,ctx,inbox); this.outcome(result,ctx);
      if (ctx.inboxDuplicate) this.telemetry.count('wager_duplicates_total',{ layer: 'inbox' });
      return result;
    } catch (error) {
      if (error instanceof DomainError && error.code==='INBOX_PAYLOAD_CONFLICT') this.telemetry.count('wager_duplicates_total',{ layer: 'inbox_conflict' });
      this.telemetry.event('wager_failed',{ ...ctx,code: error instanceof DomainError?error.code:'PROCESSING_ERROR' }); throw error;
    } finally { this.telemetry.observe('wager_processing_duration_seconds',(performance.now()-started)/1000,{ operation: 'process' }); }
  }
  private outcome(result: TransactionResult,ctx: OperationContext): void {
    if (result.idempotentReplay) this.telemetry.count('wager_duplicates_total',{ layer: 'financial' });
    else this.telemetry.count('wager_transactions_total',{ status: result.status });
    this.telemetry.event('wager_committed',{ ...ctx,transactionId: result.transactionId,status: result.status,outcome: result.idempotentReplay?'replay':'applied' });
  }
  private async executeCore(input: unknown, key: unknown, request: OperationContext = {}, inbox?: InboxReceipt): Promise<TransactionResult> {
    const command = prepareWagerCommand(input,key); const payload = command.payload;
    request.walletId=payload.walletId; request.providerId=payload.providerId;
    uuid(payload.walletId); uuid(payload.playerId);
    if (payload.providerId.startsWith('__internal')) throw new DomainError('INVALID_PROVIDER');
    const props = { ...payload,money: Money.from(payload.money),id: this.env.newId(),createdAt: this.env.now(),
      idempotencyKey: command.idempotencyKey,payloadHash: command.payloadHash };
    WagerTransaction.create(props); // Validate operation contract before any database write.
    const correlationId = request.correlationId ?? this.env.newId();
    return this.uow.run(async session => {
      const received = inbox ? await session.acceptInbox(inbox,this.env.now()) : false;
      if (inbox) request.inboxDuplicate=!received;
      const result = await (async () => {
        let existing = await session.findTransactionByKey(command.idempotencyKey);
        if (existing) {
          existing.transaction.assertPayload(command.payloadHash);
          if (existing.transaction.isTerminal()) return replay(existing);
        }
        const wallet = await session.lockWallet(payload.walletId);
        if (!wallet) throw new DomainError('WALLET_NOT_FOUND');
        // Another process may have committed while this one waited for the wallet.
        existing = await session.findTransactionByKey(command.idempotencyKey);
        if (existing) {
          existing.transaction.assertPayload(command.payloadHash);
          return existing.transaction.isTerminal() ? replay(existing) : response(existing.transaction,wallet,true);
        }
        if (await session.findTransactionByExternal(payload.providerId,payload.externalTransactionId)) throw new DomainError('EXTERNAL_TRANSACTION_CONFLICT');
        return this.apply(session,wallet,WagerTransaction.create(props),undefined,{ ...request,correlationId });
      })();
      if (inbox && received) await session.completeInbox(inbox,this.env.now());
      return result;
    },{ ...request });
  }
  /** Explicit recovery entry point; the scheduled worker/claim loop is a later adapter. */
  async resume(transactionId: string,request: RequestContext = {},claim?: ReferenceClaim): Promise<TransactionResult> {
    const started=performance.now(); const ctx: OperationContext={ ...request,correlationId: request.correlationId ?? transactionId };
    try { const result=await this.resumeCore(transactionId,ctx,claim); this.outcome(result,ctx); return result; }
    catch (error) { this.telemetry.event('reference_resume_failed',{ ...ctx,transactionId,code: error instanceof DomainError?error.code:'PROCESSING_ERROR' }); throw error; }
    finally { this.telemetry.observe('wager_processing_duration_seconds',(performance.now()-started)/1000,{ operation: 'resume' }); }
  }
  private async resumeCore(transactionId: string, request: OperationContext = {}, claim?: ReferenceClaim): Promise<TransactionResult> {
    uuid(transactionId);
    const correlationId = request.correlationId ?? this.env.newId();
    return this.uow.run(async session => {
      let stored = await session.findTransactionById(transactionId);
      if (!stored) throw new DomainError('TRANSACTION_NOT_FOUND');
      request.walletId=stored.transaction.walletId; request.providerId=stored.transaction.providerId;
      if (stored.transaction.isTerminal()) return replay(stored);
      const wallet = await session.lockWallet(stored.transaction.walletId);
      if (!wallet) throw new DomainError('WALLET_NOT_FOUND');
      stored = await session.findTransactionById(transactionId);
      if (!stored) throw new Error('TRANSACTION_DISAPPEARED');
      if (stored.transaction.isTerminal()) return replay(stored);
      if (claim && (claim.transactionId!==transactionId || !await session.ownReferenceClaim(claim))) throw new DomainError('REFERENCE_CLAIM_LOST');
      const result=await this.apply(session,wallet,stored.transaction,stored,{ ...request,correlationId });
      if (claim) await session.completeReferenceClaim(claim);
      return result;
    },{ ...request });
  }
  private async apply(session: FinancialSession, wallet: Wallet, tx: WagerTransaction,
    stored: StoredTransaction | undefined, request: RequestContext): Promise<TransactionResult> {
    const at = this.env.now(); const wasPending = tx.status === Status.PendingReference;
    let entry: WalletLedgerEntry | undefined;
    try {
      if (tx.playerId !== wallet.playerId) throw new DomainError('PLAYER_MISMATCH');
      if (tx.money.currency !== wallet.currency) throw new DomainError('CURRENCY_MISMATCH');
      const reference = tx.referenceExternalTransactionId === undefined ? undefined
        : (await session.findTransactionByExternal(tx.providerId,tx.referenceExternalTransactionId))?.transaction;
      tx.validateReference(reference);
      if (reference && tx.requiresReference() && await session.hasSuccessfulReversal(reference.id,tx.kind)) throw new DomainError('REVERSAL_ALREADY_APPLIED');
      const direction = tx.ledgerDirectionFor(reference);
      if (direction !== undefined) {
        const movement = { entryId: this.env.newId(),transactionId: tx.id,at };
        entry = direction === LedgerDirection.Debit
          ? wallet.debit(tx.money,movement,tx.requiresReference() ? 'REVERSAL' : 'BET') : wallet.credit(tx.money,movement);
      }
      tx.markProcessed(reference,at);
    } catch (error) {
      if (error instanceof Error && error.message === 'MONEY_OUT_OF_RANGE') {
        tx.reject('BALANCE_LIMIT_EXCEEDED');
      } else if (!(error instanceof DomainError)) throw error;
      else {
        if (['REFERENCE_REQUIRED','REFERENCE_PENDING'].includes(error.code)) {
          if (at.getTime() - tx.createdAt.getTime() >= 24 * 60 * 60 * 1000) tx.reject('REFERENCE_EXPIRED');
          else tx.markPendingReference();
        } else if (rejectionCodes.has(error.code as RejectionCode)) tx.reject(error.code as RejectionCode);
        else throw error;
      }
    }
    const result = response(tx,wallet);
    const attempts = (stored?.referenceAttempts ?? 0) + (stored ? 1 : 0);
    const next = tx.status === Status.PendingReference
      ? new Date(at.getTime() + Math.min(1000 * 2 ** Math.min(attempts,20) + Math.floor((this.env.random?.() ?? Math.random())*250),300000)) : null;
    await session.saveTransaction(tx,tx.isTerminal() ? result : null,!!stored,attempts,next);
    if (entry) {
      await session.saveWallet(wallet);
      await session.appendLedger(entry,wallet.version);
    }
    const eventContext = () => context(this.env,request,at);
    if (tx.status === Status.Processed) await session.enqueue(WagerTransactionProcessed.from(tx,eventContext()));
    if (tx.status === Status.Rejected) await session.enqueue(WagerTransactionRejected.from(tx,eventContext()));
    if (tx.status === Status.PendingReference && !wasPending) await session.enqueue(WagerTransactionPendingReference.from(tx,eventContext()));
    if (entry) await session.enqueue(WalletBalanceChanged.from(wallet,entry,eventContext()));
    return result;
  }
}
