import { expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { ExactAmountType, MoneyMapper } from '../../src/infrastructure/persistence/money-mapper';

test.each(['0.00', '25.00', '-25.00', '999999999999999999.99', '-999999999999999999.99'])('persistence roundtrip preserves %s exactly', amount => {
  const money = MoneyMapper.fromColumns({ amount, currency: 'BRL' });
  expect(MoneyMapper.toColumns(money)).toEqual({ amount, currency: 'BRL' });
});
test.each(['1', '1.0', '1.001', '-0.00', '01.00', '1e2', 'NaN', 'Infinity', '1000000000000000000.00'])('rejects malformed or overflowing persisted amount %s', amount => {
  expect(() => Money.rehydrate({ amount, currency: 'BRL' })).toThrow();
});
test('driver numeric coercion is refused in both directions', () => {
  const type = new ExactAmountType();
  expect(() => type.convertToJSValue(25 as unknown as string)).toThrow('INVALID_PERSISTED_MONEY');
  expect(() => type.convertToDatabaseValue(25 as unknown as string)).toThrow('INVALID_PERSISTED_MONEY');
  expect(type.convertToJSValue('25.00')).toBe('25.00');
  expect(type.convertToJSValue('25')).toBe('25.00');
  expect(type.convertToJSValue('-25.1')).toBe('-25.10');
  expect(() => type.convertToJSValue('25.001')).toThrow('INVALID_PERSISTED_MONEY');
  expect(type.convertToDatabaseValue('-25.00')).toBe('-25.00');
  expect(type.compareAsType()).toBe('string');
});
test('signed rehydration does not make negative public inputs valid', () => {
  expect(Money.rehydrate({ amount: '-1.00', currency: 'BRL' }).isNegative()).toBe(true);
  expect(() => Money.from({ amount: '-1.00', currency: 'BRL' })).toThrow('INVALID_MONEY_AMOUNT');
});
