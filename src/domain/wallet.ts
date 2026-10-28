import { Money } from './money';
import { DomainError } from './domain-error';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface MovementContext { entryId: string; transactionId: string; at: Date }

export class Wallet {
  private readonly createdAtMs: number;
  private updatedAtMs: number;
  private _balance: Money;
  private _version: number;
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    state: WalletState,
  ) {
    this._balance = state.balance;
    this._version = state.version;
    this.createdAtMs = state.createdAt.getTime();
    this.updatedAtMs = state.updatedAt.getTime();
  }

  static open(props: {
    id: string; playerId: string; initialBalance: Money; at: Date;
    opening?: { entryId: string; transactionId: string };
  }): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
    if (!props.id || !props.playerId) throw new DomainError('INVALID_WALLET_IDENTITY');
    if (!Number.isFinite(props.at.getTime())) throw new DomainError('INVALID_TIMESTAMP');
    if (props.initialBalance.isNegative()) throw new DomainError('NEGATIVE_INITIAL_BALANCE');
    let openingEntry: WalletLedgerEntry | undefined;
    if (props.initialBalance.isPositive()) {
      if (!props.opening) throw new DomainError('OPENING_CONTEXT_REQUIRED');
      openingEntry = WalletLedgerEntry.create({
        id: props.opening.entryId, walletId: props.id, transactionId: props.opening.transactionId,
        direction: LedgerDirection.Credit, money: props.initialBalance,
        balanceBefore: Money.zero(props.initialBalance.currency), balanceAfter: props.initialBalance,
        createdAt: props.at,
      });
    }
    const wallet = Wallet.rehydrate({
      id: props.id, playerId: props.playerId, currency: props.initialBalance.currency,
      balance: props.initialBalance, version: 1, createdAt: props.at, updatedAt: props.at,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state);
  }
  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get createdAt(): Date { return new Date(this.createdAtMs); }
  get updatedAt(): Date { return new Date(this.updatedAtMs); }

  debit(money: Money, ctx: MovementContext, reason: 'BET' | 'REVERSAL' = 'BET'): WalletLedgerEntry {
    return this.move(money, ctx, LedgerDirection.Debit, reason);
  }
  credit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    return this.move(money, ctx, LedgerDirection.Credit, 'BET');
  }
  private move(money: Money, ctx: MovementContext, direction: LedgerDirection, reason: 'BET' | 'REVERSAL'): WalletLedgerEntry {
    if (money.currency !== this.currency) throw new DomainError('CURRENCY_MISMATCH');
    if (!money.isPositive()) throw new DomainError('INVALID_MOVEMENT_AMOUNT');
    const after = direction === LedgerDirection.Debit ? this._balance.subtract(money) : this._balance.add(money);
    if (after.isNegative()) {
      throw new DomainError(reason === 'REVERSAL' ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS');
    }
    if (!Number.isSafeInteger(this._version + 1)) throw new DomainError('WALLET_VERSION_OUT_OF_RANGE');
    // Build and validate the entry before changing any aggregate state.
    const entry = WalletLedgerEntry.create({
      id: ctx.entryId, walletId: this.id, transactionId: ctx.transactionId,
      direction, money, balanceBefore: this._balance, balanceAfter: after, createdAt: ctx.at,
    });
    this._balance = after;
    this._version++;
    this.updatedAtMs = ctx.at.getTime();
    return entry;
  }
}
