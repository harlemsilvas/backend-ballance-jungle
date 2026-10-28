import { DomainError } from '../domain-error';
import type { MoneyProps } from '../money';
import { Wallet } from '../wallet';
import { WalletLedgerEntry, type LedgerDirection } from '../wallet-ledger-entry';
import { WagerTransaction, WagerTransactionStatus, type WagerTransactionKind, type FailureCode } from '../wager-transaction';
import { IntegrationEvent, type EventContext, type IntegrationEventProps } from './integration-event';

interface TransactionData {
  transactionId: string; providerId: string; externalTransactionId: string;
  walletId: string; playerId: string; roundId: string; gameId: string;
  kind: WagerTransactionKind; money: MoneyProps;
}
function transactionData(tx: WagerTransaction): TransactionData {
  return { transactionId: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId, playerId: tx.playerId, roundId: tx.roundId, gameId: tx.gameId,
    kind: tx.kind, money: tx.money.toJSON() };
}
export interface ProcessedData extends TransactionData {
  status: WagerTransactionStatus.Processed; processedAt: string; referenceTransactionId?: string;
}
export class WagerTransactionProcessed extends IntegrationEvent<ProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<ProcessedData>) { super(props); Object.freeze(this); }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (tx.status !== WagerTransactionStatus.Processed || !tx.processedAt) throw new DomainError('INVALID_EVENT_SOURCE');
    return new WagerTransactionProcessed({ ...ctx, aggregateId: tx.walletId, data: {
      ...transactionData(tx), status: WagerTransactionStatus.Processed, processedAt: tx.processedAt.toISOString(),
      ...(tx.referenceTransactionId === undefined ? {} : { referenceTransactionId: tx.referenceTransactionId }),
    } });
  }
}
export interface RejectedData extends TransactionData { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
export class WagerTransactionRejected extends IntegrationEvent<RejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<RejectedData>) { super(props); Object.freeze(this); }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (tx.status !== WagerTransactionStatus.Rejected || !tx.failureCode) throw new DomainError('INVALID_EVENT_SOURCE');
    return new WagerTransactionRejected({ ...ctx, aggregateId: tx.walletId, data: {
      ...transactionData(tx), status: WagerTransactionStatus.Rejected, failureCode: tx.failureCode,
    } });
  }
}
export interface PendingReferenceData extends TransactionData {
  status: WagerTransactionStatus.PendingReference; referenceExternalTransactionId: string;
}
export class WagerTransactionPendingReference extends IntegrationEvent<PendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<PendingReferenceData>) { super(props); Object.freeze(this); }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (tx.status !== WagerTransactionStatus.PendingReference || !tx.referenceExternalTransactionId) throw new DomainError('INVALID_EVENT_SOURCE');
    return new WagerTransactionPendingReference({ ...ctx, aggregateId: tx.walletId, data: {
      ...transactionData(tx), status: WagerTransactionStatus.PendingReference,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
    } });
  }
}
export interface WalletBalanceChangedData {
  walletId: string; transactionId: string; direction: LedgerDirection;
  money: MoneyProps; balanceBefore: MoneyProps; balanceAfter: MoneyProps; walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) { super(props); Object.freeze(this); }
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (wallet.id !== entry.walletId || !wallet.balance.equals(entry.balanceAfter)
      || !entry.isBalanced() || !entry.money.isPositive()
      || !Number.isSafeInteger(wallet.version) || wallet.version < 1) throw new DomainError('INVALID_EVENT_SOURCE');
    return new WalletBalanceChanged({ ...ctx, aggregateId: wallet.id, data: {
      walletId: wallet.id, transactionId: entry.transactionId, direction: entry.direction,
      money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version,
    } });
  }
}
