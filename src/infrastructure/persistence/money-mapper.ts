import { Money, type MoneyProps } from '../../domain/money';
import { Type } from '@mikro-orm/core';

export const MoneyMapper = {
  toColumns(money: Money): MoneyProps { return money.toJSON(); },
  fromColumns(columns: MoneyProps): Money { return Money.rehydrate(columns); },
};
/** PostgreSQL numeric stays a string in both directions; never coerce a driver number. */
export class ExactAmountType extends Type<string, string> {
  override convertToDatabaseValue(value: string): string { return this.checked(value); }
  override convertToJSValue(value: string): string {
    // An unconstrained PostgreSQL numeric may arrive as "25" or "25.0".
    // Normalize text only, without rounding or accepting a JS number.
    if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) throw new Error('INVALID_PERSISTED_MONEY');
    const negative = value.startsWith('-');
    const money = Money.from({ amount: negative ? value.slice(1) : value, currency: 'BRL' });
    return (negative ? money.negate() : money).toString();
  }
  override getColumnType(): string { return 'numeric'; }
  override compareAsType(): string { return 'string'; }
  private checked(value: string): string {
    return Money.rehydrate({ amount: value, currency: 'BRL' }).toString();
  }
}
