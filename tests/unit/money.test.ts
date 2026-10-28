import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test.each(['', ' ', 'NaN', 'Infinity', '1e2', '-1.00', '1.001', '01.00', '.50', '1.', '+1', '1,00'])('rejects invalid input %s', amount => {
    expect(() => brl(amount)).toThrow('INVALID_MONEY_AMOUNT');
  });
  test('rejects numeric input at runtime', () => {
    expect(() => Money.from({ amount: 1 as unknown as string, currency: 'BRL' })).toThrow();
  });
  test('normalizes without rounding', () => {
    expect(brl('1.2').toJSON()).toEqual({ amount: '1.20', currency: 'BRL' });
    expect(brl('1').toString()).toBe('1.00');
  });
  test('calculates exactly and preserves operands', () => {
    const a = brl('0.10');
    expect(a.add(brl('0.20')).toString()).toBe('0.30');
    expect(a.toString()).toBe('0.10');
    expect(Object.isFrozen(a)).toBe(true);
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
  });
  test('supports signed internal results and queries', () => {
    const negative = brl('1').subtract(brl('2'));
    expect(negative.isNegative()).toBe(true);
    expect(negative.negate().equals(brl('1'))).toBe(true);
    expect(brl('2').isPositive()).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('1').isLessThan(brl('2'))).toBe(true);
  });
  test('retains all digits at the persistence boundary', () => {
    expect(brl('999999999999999999.98').add(brl('0.01')).toString()).toBe('999999999999999999.99');
    expect(() => brl('999999999999999999.99').add(brl('0.01'))).toThrow('MONEY_OUT_OF_RANGE');
    expect(() => brl('1000000000000000000')).toThrow('MONEY_OUT_OF_RANGE');
  });
  test('rejects invalid currency and cross-currency operations', () => {
    expect(() => Money.zero('brl')).toThrow('INVALID_CURRENCY');
    const usd = Money.zero('USD');
    for (const op of [() => brl('1').add(usd), () => brl('1').subtract(usd), () => brl('1').equals(usd), () => brl('1').isLessThan(usd)]) {
      expect(op).toThrow('CURRENCY_MISMATCH');
    }
  });
});
