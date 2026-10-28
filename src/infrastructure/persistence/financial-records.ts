import { EntitySchema } from '@mikro-orm/core';
import { ExactAmountType } from './money-mapper';

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export const WalletSchema = new EntitySchema<WalletRow>({
  name: 'WalletRecord', tableName: 'wallets',
  properties: {
    id: { type: 'uuid', fieldName: 'id', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', fieldName: 'currency' },
    balance: { type: ExactAmountType, fieldName: 'balance' },
    version: { type: 'integer', fieldName: 'version' },
    createdAt: { type: Date, fieldName: 'created_at', columnType: 'timestamptz' },
    updatedAt: { type: Date, fieldName: 'updated_at', columnType: 'timestamptz' },
  },
});

export interface WagerTransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  createdAt: Date;
  processedAt: Date | null;
  resultSnapshot: Record<string, unknown> | null;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | null;
}
export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  name: 'WagerTransactionRecord', tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', fieldName: 'id', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string', fieldName: 'kind' },
    amount: { type: ExactAmountType, fieldName: 'amount' },
    currency: { type: 'string', fieldName: 'currency' },
    referenceExternalTransactionId: { type: 'string', fieldName: 'reference_external_transaction_id', nullable: true },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'string', fieldName: 'status' },
    failureCode: { type: 'string', fieldName: 'failure_code', nullable: true },
    createdAt: { type: Date, fieldName: 'created_at', columnType: 'timestamptz' },
    processedAt: { type: Date, fieldName: 'processed_at', nullable: true, columnType: 'timestamptz' },
    resultSnapshot: { type: 'json', fieldName: 'result_snapshot', nullable: true, columnType: 'jsonb' },
    referenceAttempts: { type: 'integer', fieldName: 'reference_attempts' },
    nextReferenceAttemptAt: { type: Date, fieldName: 'next_reference_attempt_at', nullable: true, columnType: 'timestamptz' },
  },
});

export interface WalletLedgerRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: Date;
}
export const WalletLedgerSchema = new EntitySchema<WalletLedgerRow>({
  name: 'WalletLedgerRecord', tableName: 'wallet_ledger',
  properties: {
    id: { type: 'uuid', fieldName: 'id', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string', fieldName: 'direction' },
    amount: { type: ExactAmountType, fieldName: 'amount' },
    currency: { type: 'string', fieldName: 'currency' },
    balanceBefore: { type: ExactAmountType, fieldName: 'balance_before' },
    balanceAfter: { type: ExactAmountType, fieldName: 'balance_after' },
    walletVersion: { type: 'integer', fieldName: 'wallet_version' },
    createdAt: { type: Date, fieldName: 'created_at', columnType: 'timestamptz' },
  },
});

export interface InboxRow {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}
export const InboxSchema = new EntitySchema<InboxRow>({
  name: 'InboxRecord', tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', fieldName: 'consumer_name', primary: true },
    messageId: { type: 'string', fieldName: 'message_id', primary: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    receivedAt: { type: Date, fieldName: 'received_at', columnType: 'timestamptz' },
    processedAt: { type: Date, fieldName: 'processed_at', nullable: true, columnType: 'timestamptz' },
  },
});

export interface OutboxRow {
  id: string;
  aggregateId: string;
  eventType: string;
  leaseToken: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
  leaseUntil: Date | null;
}
export const OutboxSchema = new EntitySchema<OutboxRow>({
  name: 'OutboxRecord', tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', fieldName: 'id', primary: true },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type' },
    leaseToken: { type: 'uuid', fieldName: 'lease_token', nullable: true },
    payload: { type: 'json', fieldName: 'payload', columnType: 'jsonb' },
    occurredAt: { type: Date, fieldName: 'occurred_at', columnType: 'timestamptz' },
    attempts: { type: 'integer', fieldName: 'attempts' },
    nextAttemptAt: { type: Date, fieldName: 'next_attempt_at', nullable: true, columnType: 'timestamptz' },
    publishedAt: { type: Date, fieldName: 'published_at', nullable: true, columnType: 'timestamptz' },
    leaseUntil: { type: Date, fieldName: 'lease_until', nullable: true, columnType: 'timestamptz' },
  },
});

export const financialEntities = [WalletSchema, WagerTransactionSchema, WalletLedgerSchema, InboxSchema, OutboxSchema];
