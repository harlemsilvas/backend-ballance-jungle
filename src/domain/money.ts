import Decimal from 'decimal.js';

const ExactDecimal = Decimal.clone({ precision: 50 });
const MAX = new ExactDecimal('999999999999999999.99');
export interface MoneyProps { amount: string; currency: string }

export class Money {
  private constructor(private readonly value: Decimal, public readonly currency: string) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(props.amount)) {
      throw new Error('INVALID_MONEY_AMOUNT');
    }
    return Money.checked(new ExactDecimal(props.amount), props.currency);
  }

  /** Trusted persistence format, including signed internal results; no operation is replayed. */
  static rehydrate(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !/^-?(0|[1-9]\d*)\.\d{2}$/.test(props.amount)
      || props.amount === '-0.00') throw new Error('INVALID_PERSISTED_MONEY');
    return Money.checked(new ExactDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money { return Money.from({ amount: '0.00', currency }); }

  private static checked(value: Decimal, currency: string): Money {
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('INVALID_CURRENCY');
    if (!value.isFinite() || value.abs().gt(MAX)) throw new Error('MONEY_OUT_OF_RANGE');
    return new Money(value, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new Error('CURRENCY_MISMATCH');
  }

  add(other: Money): Money { this.assertSameCurrency(other); return Money.checked(this.value.plus(other.value), this.currency); }
  subtract(other: Money): Money { this.assertSameCurrency(other); return Money.checked(this.value.minus(other.value), this.currency); }
  negate(): Money { return Money.checked(this.value.negated(), this.currency); }
  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return this.value.gt(0); }
  isNegative(): boolean { return this.value.lt(0); }
  isLessThan(other: Money): boolean { this.assertSameCurrency(other); return this.value.lt(other.value); }
  equals(other: Money): boolean { this.assertSameCurrency(other); return this.value.eq(other.value); }
  toJSON(): MoneyProps { return { amount: this.value.toFixed(2), currency: this.currency }; }
  toString(): string { return this.value.toFixed(2); }
}
