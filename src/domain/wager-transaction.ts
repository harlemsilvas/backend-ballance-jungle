import { Money } from './money';
import { DomainError } from './domain-error';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING', Bet = 'BET', Win = 'WIN', Loss = 'LOSS', Refund = 'REFUND', Rollback = 'ROLLBACK',
}
export enum WagerTransactionStatus {
  Pending = 'PENDING', PendingReference = 'PENDING_REFERENCE', Processed = 'PROCESSED',
  Rejected = 'REJECTED', Failed = 'FAILED',
}
export type RejectionCode =
  | 'WALLET_NOT_FOUND' | 'PLAYER_MISMATCH' | 'CURRENCY_MISMATCH' | 'INSUFFICIENT_FUNDS'
  | 'REVERSAL_INSUFFICIENT_FUNDS' | 'BALANCE_LIMIT_EXCEEDED' | 'REFERENCE_MISMATCH' | 'REFERENCE_KIND_INVALID'
  | 'REFERENCE_NOT_PROCESSED' | 'REFERENCE_EXPIRED' | 'REVERSAL_ALREADY_APPLIED';
export type FailureCode = RejectionCode | 'PERMANENT_INFRASTRUCTURE_FAILURE';
export interface CreateWagerTransactionProps {
  id: string; providerId: string; externalTransactionId: string; idempotencyKey: string;
  payloadHash: string; walletId: string; playerId: string; roundId: string; gameId: string;
  kind: WagerTransactionKind; money: Money; referenceExternalTransactionId?: string;
  createdAt: Date;
}
export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus; referenceTransactionId?: string;
  failureCode?: FailureCode; processedAt?: Date;
}

export class WagerTransaction {
  private readonly props: Readonly<Omit<CreateWagerTransactionProps, 'createdAt'>>;
  private readonly createdAtMs: number;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private processedAtMs: number | undefined;
  private constructor(state: WagerTransactionState) {
    const { status, referenceTransactionId, failureCode, processedAt, createdAt, ...props } = state;
    this.props = Object.freeze(props);
    this.createdAtMs = createdAt.getTime();
    this._status = status;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = failureCode;
    this.processedAtMs = processedAt?.getTime();
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) throw new DomainError('OPENING_IS_INTERNAL');
    return WagerTransaction.build(props);
  }
  /** Only the wallet-opening use case may call this factory. */
  static createOpening(props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>): WagerTransaction {
    return WagerTransaction.build({ ...props, kind: WagerTransactionKind.Opening });
  }
  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    if (!Object.values(WagerTransactionKind).includes(props.kind)) throw new DomainError('INVALID_TRANSACTION_KIND');
    for (const value of [props.id, props.providerId, props.externalTransactionId, props.idempotencyKey,
      props.walletId, props.playerId, props.roundId, props.gameId]) {
      if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID_TRANSACTION_IDENTITY');
    }
    if (!/^[a-f0-9]{64}$/.test(props.payloadHash)) throw new DomainError('INVALID_PAYLOAD_HASH');
    if (!Number.isFinite(props.createdAt.getTime())) throw new DomainError('INVALID_TIMESTAMP');
    if (props.kind === WagerTransactionKind.Loss ? !props.money.isZero() : !props.money.isPositive()) {
      throw new DomainError('INVALID_TRANSACTION_AMOUNT');
    }
    const requires = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    const ref = props.referenceExternalTransactionId;
    if (requires && ref === undefined) throw new DomainError('REFERENCE_REQUIRED');
    if (ref !== undefined) {
      if (typeof ref !== 'string' || !ref.trim() || ref === props.externalTransactionId) throw new DomainError('INVALID_REFERENCE');
      if (![WagerTransactionKind.Refund, WagerTransactionKind.Rollback, WagerTransactionKind.Win].includes(props.kind)) {
        throw new DomainError('REFERENCE_NOT_ALLOWED');
      }
    }
    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending });
  }
  static rehydrate(state: WagerTransactionState): WagerTransaction { return new WagerTransaction(state); }
  get id(): string { return this.props.id; }
  get providerId(): string { return this.props.providerId; }
  get externalTransactionId(): string { return this.props.externalTransactionId; }
  get idempotencyKey(): string { return this.props.idempotencyKey; }
  get payloadHash(): string { return this.props.payloadHash; }
  get walletId(): string { return this.props.walletId; }
  get playerId(): string { return this.props.playerId; }
  get roundId(): string { return this.props.roundId; }
  get gameId(): string { return this.props.gameId; }
  get kind(): WagerTransactionKind { return this.props.kind; }
  get money(): Money { return this.props.money; }
  get referenceExternalTransactionId(): string | undefined { return this.props.referenceExternalTransactionId; }
  get createdAt(): Date { return new Date(this.createdAtMs); }
  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this.processedAtMs === undefined ? undefined : new Date(this.processedAtMs); }
  isTerminal(): boolean {
    return [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed].includes(this._status);
  }
  requiresReference(): boolean { return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback; }
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss && ![WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed].includes(this._status);
  }
  matchesPayload(hash: string): boolean { return this.payloadHash === hash; }
  assertPayload(hash: string): void {
    if (!this.matchesPayload(hash)) throw new DomainError('IDEMPOTENCY_CONFLICT');
  }
  private assertMutable(): void {
    if (this.isTerminal()) throw new DomainError('INVALID_TRANSACTION_STATE');
  }
  markPendingReference(): void {
    this.assertMutable();
    if (!this.referenceExternalTransactionId) throw new DomainError('REFERENCE_NOT_ALLOWED');
    this._status = WagerTransactionStatus.PendingReference;
  }
  markProcessed(reference: WagerTransaction | undefined, at: Date): void {
    this.assertMutable();
    if (!Number.isFinite(at.getTime())) throw new DomainError('INVALID_TIMESTAMP');
    this.ledgerDirectionFor(reference); // validates the reference before mutating terminal state
    this._referenceTransactionId = reference?.id;
    this.processedAtMs = at.getTime();
    this._status = WagerTransactionStatus.Processed;
  }
  reject(code: RejectionCode): void {
    this.assertMutable();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Rejected;
  }
  fail(code: 'PERMANENT_INFRASTRUCTURE_FAILURE'): void {
    this.assertMutable();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Failed;
  }
  validateReference(reference: WagerTransaction | undefined): void {
    if (!this.referenceExternalTransactionId) {
      if (reference) throw new DomainError('REFERENCE_NOT_ALLOWED');
      return;
    }
    if (!reference) throw new DomainError('REFERENCE_REQUIRED');
    if (reference.id === this.id || reference.externalTransactionId !== this.referenceExternalTransactionId
      || reference.providerId !== this.providerId || reference.playerId !== this.playerId
      || reference.walletId !== this.walletId || reference.money.currency !== this.money.currency
      || reference.roundId !== this.roundId) throw new DomainError('REFERENCE_MISMATCH');
    const allowed = this.kind === WagerTransactionKind.Rollback
      ? [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund] : [WagerTransactionKind.Bet];
    if (!allowed.includes(reference.kind)) throw new DomainError('REFERENCE_KIND_INVALID');
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new DomainError(reference.isTerminal() ? 'REFERENCE_NOT_PROCESSED' : 'REFERENCE_PENDING');
    }
    if (this.requiresReference() && !this.money.equals(reference.money)) throw new DomainError('REFERENCE_MISMATCH');
  }
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    this.validateReference(reference);
    switch (this.kind) {
      case WagerTransactionKind.Bet: return LedgerDirection.Debit;
      case WagerTransactionKind.Loss: return undefined;
      case WagerTransactionKind.Rollback:
        return reference?.kind === WagerTransactionKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
      default: return LedgerDirection.Credit;
    }
  }
}
