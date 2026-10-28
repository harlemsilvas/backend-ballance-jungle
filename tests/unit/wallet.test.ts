import { describe, expect, test } from 'bun:test';
import { Wallet } from '../../src/domain/wallet';
import { Money } from '../../src/domain/money';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
const at = new Date('2026-10-26T12:00:00Z');
const later = new Date('2026-10-26T12:01:00Z');
const ctx = () => ({ entryId: 'entry-1', transactionId: 'tx-1', at: later });
const open = (amount = '100') => Wallet.open({
  id: 'wallet-1', playerId: 'player-1', initialBalance: money(amount), at,
  opening: { entryId: 'opening-entry', transactionId: 'opening-tx' },
});

describe('Wallet', () => {
  test('positive opening returns a balanced credit and starts at version 1', () => {
    const { wallet, openingEntry } = open();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(openingEntry?.isBalanced()).toBe(true);
  });
  test('zero opening creates no ledger', () => {
    const { wallet, openingEntry } = Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.zero('BRL'), at });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });
  test('positive opening requires ledger identity and negative opening fails', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('1'), at })).toThrow('OPENING_CONTEXT_REQUIRED');
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('1').negate(), at })).toThrow('NEGATIVE_INITIAL_BALANCE');
  });
  test('debit and credit return matching entries and increment version once each', () => {
    const { wallet } = open();
    const debit = wallet.debit(money('80'), ctx());
    expect(debit.balanceBefore.toString()).toBe('100.00');
    expect(debit.balanceAfter.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    const credit = wallet.credit(money('5'), { ...ctx(), transactionId: 'tx-2', entryId: 'entry-2' });
    expect(credit.balanceBefore.toString()).toBe('20.00');
    expect(wallet.balance.toString()).toBe('25.00');
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt).toEqual(later);
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(credit.direction).toBe(LedgerDirection.Credit);
  });
  test('allows debit of the exact available balance', () => {
    const { wallet } = open();
    wallet.debit(money('100'), ctx());
    expect(wallet.balance.isZero()).toBe(true);
  });
  test('failed bet and reversal have distinct codes and preserve state', () => {
    const { wallet } = open();
    expect(() => wallet.debit(money('101'), ctx())).toThrow('INSUFFICIENT_FUNDS');
    expect(() => wallet.debit(money('101'), ctx(), 'REVERSAL')).toThrow('REVERSAL_INSUFFICIENT_FUNDS');
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(at);
  });
  test('invalid amounts, currencies and ledger context do not mutate wallet', () => {
    const { wallet } = open();
    for (const operation of [
      () => wallet.credit(money('1', 'USD'), ctx()),
      () => wallet.debit(money('1', 'USD'), ctx()),
      () => wallet.credit(money('0'), ctx()),
      () => wallet.debit(money('1').negate(), ctx()),
      () => wallet.credit(money('1'), { ...ctx(), entryId: '' }),
      () => wallet.debit(money('1'), { ...ctx(), at: new Date('invalid') }),
    ]) expect(operation).toThrow();
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
  test('overflow leaves balance and version unchanged', () => {
    const { wallet } = open('999999999999999999.99');
    expect(() => wallet.credit(money('0.01'), ctx())).toThrow('MONEY_OUT_OF_RANGE');
    expect(wallet.balance.toString()).toBe('999999999999999999.99');
    expect(wallet.version).toBe(1);
  });
  test('rehydrate reconstructs state without creating a movement', () => {
    const inputDate = new Date(at);
    const wallet = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: money('25'), version: 7, createdAt: inputDate, updatedAt: inputDate });
    inputDate.setFullYear(2000);
    wallet.updatedAt.setFullYear(2001);
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe('25.00');
    expect(wallet.createdAt).toEqual(at);
    expect(wallet.updatedAt).toEqual(at);
  });
});
