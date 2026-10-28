import type { LogFields } from './telemetry';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { WagerTransaction, WagerTransactionStatus, FailureCode } from '../domain/wager-transaction';
import type { MoneyProps } from '../domain/money';
import type { IntegrationEvent } from '../domain/events/integration-event';

export interface TransactionResult {
  transactionId: string; status: WagerTransactionStatus; balance: MoneyProps;
  failureCode?: FailureCode; idempotentReplay: boolean;
}
export interface StoredTransaction {
  transaction: WagerTransaction; result: TransactionResult | null;
  referenceAttempts: number; nextReferenceAttemptAt: Date | null;
}
export interface InboxReceipt { consumerName: string; messageId: string; payloadHash: string }
export interface ReferenceClaim { transactionId: string; token: string }
export interface FinancialSession {
  ownReferenceClaim(claim: ReferenceClaim): Promise<boolean>;
  completeReferenceClaim(claim: ReferenceClaim): Promise<void>;
  acceptInbox(receipt: InboxReceipt,at: Date): Promise<boolean>;
  completeInbox(receipt: InboxReceipt,at: Date): Promise<void>;
  lockWallet(id: string): Promise<Wallet | undefined>;
  findWalletByOwner(playerId: string, currency: string): Promise<Wallet | undefined>;
  insertWallet(wallet: Wallet): Promise<void>;
  saveWallet(wallet: Wallet): Promise<void>;
  findTransactionByKey(key: string): Promise<StoredTransaction | undefined>;
  findTransactionById(id: string): Promise<StoredTransaction | undefined>;
  findTransactionByExternal(provider: string, external: string): Promise<StoredTransaction | undefined>;
  hasSuccessfulReversal(reference: string, kind: string): Promise<boolean>;
  saveTransaction(tx: WagerTransaction, result: TransactionResult | null,
    existing: boolean, attempts: number, nextAttempt: Date | null): Promise<void>;
  appendLedger(entry: WalletLedgerEntry, version: number): Promise<void>;
  enqueue(event: IntegrationEvent<unknown>): Promise<void>;
}
export interface FinancialUnitOfWork {
  /** Callback may be retried after rollback; no network, ack or publication inside. */
  run<T>(work: (session: FinancialSession) => Promise<T>,context?: LogFields): Promise<T>;
}
export interface ExecutionEnvironment { now(): Date; newId(): string; random?(): number }
export interface RequestContext { correlationId?: string; causationId?: string }
