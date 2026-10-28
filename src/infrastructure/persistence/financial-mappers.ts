import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus, type FailureCode } from '../../domain/wager-transaction';
import { WalletLedgerEntry, type LedgerDirection } from '../../domain/wallet-ledger-entry';
import type { WagerTransactionRow, WalletLedgerRow } from './financial-records';
import { MoneyMapper } from './money-mapper';

export const TransactionMapper = {
  fromRow(row: WagerTransactionRow): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id, providerId: row.providerId, externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey, payloadHash: row.payloadHash, walletId: row.walletId,
      playerId: row.playerId, roundId: row.roundId, gameId: row.gameId,
      kind: row.kind as WagerTransactionKind, status: row.status as WagerTransactionStatus,
      money: MoneyMapper.fromColumns({ amount: row.amount, currency: row.currency }), createdAt: row.createdAt,
      ...(row.referenceExternalTransactionId === null ? {} : { referenceExternalTransactionId: row.referenceExternalTransactionId }),
      ...(row.referenceTransactionId === null ? {} : { referenceTransactionId: row.referenceTransactionId }),
      ...(row.failureCode === null ? {} : { failureCode: row.failureCode as FailureCode }),
      ...(row.processedAt === null ? {} : { processedAt: row.processedAt }),
    });
  },
  toRow(tx: WagerTransaction): Omit<WagerTransactionRow, 'resultSnapshot' | 'referenceAttempts' | 'nextReferenceAttemptAt'> {
    return { id: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey, payloadHash: tx.payloadHash, walletId: tx.walletId, playerId: tx.playerId,
      roundId: tx.roundId, gameId: tx.gameId, kind: tx.kind, status: tx.status,
      amount: tx.money.toJSON().amount, currency: tx.money.currency, createdAt: tx.createdAt,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null, failureCode: tx.failureCode ?? null,
      processedAt: tx.processedAt ?? null };
  },
};
export const LedgerMapper = {
  toRow(entry: WalletLedgerEntry, walletVersion: number): WalletLedgerRow {
    return { id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId, direction: entry.direction,
      amount: entry.money.toJSON().amount, currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount, balanceAfter: entry.balanceAfter.toJSON().amount,
      walletVersion, createdAt: entry.createdAt };
  },
  fromRow(row: WalletLedgerRow): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({ id: row.id, walletId: row.walletId, transactionId: row.transactionId,
      direction: row.direction as LedgerDirection, money: MoneyMapper.fromColumns({ amount: row.amount, currency: row.currency }),
      balanceBefore: MoneyMapper.fromColumns({ amount: row.balanceBefore, currency: row.currency }),
      balanceAfter: MoneyMapper.fromColumns({ amount: row.balanceAfter, currency: row.currency }), createdAt: row.createdAt });
  },
};
