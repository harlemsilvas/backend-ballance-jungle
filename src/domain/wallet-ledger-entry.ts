import { Money } from './money';
import { DomainError } from './domain-error';

export enum LedgerDirection { Debit = 'DEBIT', Credit = 'CREDIT' }
export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private readonly state: Readonly<Omit<LedgerEntryState, 'createdAt'>>;
  private readonly createdAtMs: number;
  private constructor(state: LedgerEntryState) {
    const { createdAt, ...rest } = state;
    this.state = Object.freeze(rest);
    this.createdAtMs = createdAt.getTime();
    Object.freeze(this);
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    if (!state.id || !state.walletId || !state.transactionId) throw new DomainError('INVALID_LEDGER_IDENTITY');
    if (!Object.values(LedgerDirection).includes(state.direction)) throw new DomainError('INVALID_LEDGER_DIRECTION');
    if (!Number.isFinite(state.createdAt.getTime())) throw new DomainError('INVALID_TIMESTAMP');
    if (!state.money.isPositive()) throw new DomainError('INVALID_MOVEMENT_AMOUNT');
    if (state.balanceBefore.isNegative() || state.balanceAfter.isNegative()) throw new DomainError('NEGATIVE_LEDGER_BALANCE');
    const entry = new WalletLedgerEntry(state);
    if (!entry.isBalanced()) throw new DomainError('UNBALANCED_LEDGER_ENTRY');
    return entry;
  }

  /** Trusted persistence state only; never used to validate a submitted operation. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry { return new WalletLedgerEntry(state); }
  get id(): string { return this.state.id; }
  get walletId(): string { return this.state.walletId; }
  get transactionId(): string { return this.state.transactionId; }
  get direction(): LedgerDirection { return this.state.direction; }
  get money(): Money { return this.state.money; }
  get balanceBefore(): Money { return this.state.balanceBefore; }
  get balanceAfter(): Money { return this.state.balanceAfter; }
  get createdAt(): Date { return new Date(this.createdAtMs); }
  isBalanced(): boolean {
    // Both comparisons enforce the same currency even if numerical balances match.
    this.money.add(Money.zero(this.balanceBefore.currency));
    const expected = this.direction === LedgerDirection.Credit
      ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
