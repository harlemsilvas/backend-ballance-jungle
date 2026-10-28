import { expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { LedgerDirection, WalletLedgerEntry, type LedgerEntryState } from '../../src/domain/wallet-ledger-entry';
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const state = (): LedgerEntryState => ({
  id: 'entry', walletId: 'wallet', transactionId: 'transaction', direction: LedgerDirection.Debit,
  money: brl('25'), balanceBefore: brl('100'), balanceAfter: brl('75'), createdAt: new Date('2026-10-26T12:00:00Z'),
});
test('ledger validates both debit and credit arithmetic', () => {
  expect(WalletLedgerEntry.create(state()).isBalanced()).toBe(true);
  expect(WalletLedgerEntry.create({ ...state(), direction: LedgerDirection.Credit, balanceAfter: brl('125') }).isBalanced()).toBe(true);
  expect(() => WalletLedgerEntry.create({ ...state(), balanceAfter: brl('74') })).toThrow('UNBALANCED_LEDGER_ENTRY');
});
test('ledger rejects currency mismatch even when arithmetic amounts match', () => {
  expect(() => WalletLedgerEntry.create({ ...state(), balanceAfter: Money.from({ amount: '75', currency: 'USD' }) })).toThrow('CURRENCY_MISMATCH');
});
test('ledger rejects zero, negative amount, negative balance and invalid direction', () => {
  expect(() => WalletLedgerEntry.create({ ...state(), money: brl('0') })).toThrow('INVALID_MOVEMENT_AMOUNT');
  expect(() => WalletLedgerEntry.create({ ...state(), money: brl('1').negate() })).toThrow('INVALID_MOVEMENT_AMOUNT');
  expect(() => WalletLedgerEntry.create({ ...state(), balanceAfter: brl('1').negate() })).toThrow('NEGATIVE_LEDGER_BALANCE');
  expect(() => WalletLedgerEntry.create({ ...state(), direction: 'OTHER' as LedgerDirection })).toThrow('INVALID_LEDGER_DIRECTION');
});
test('ledger snapshots inputs and dates and is frozen', () => {
  const input = state();
  const entry = WalletLedgerEntry.create(input);
  input.id = 'changed';
  input.createdAt.setFullYear(2000);
  entry.createdAt.setFullYear(2001);
  expect(entry.id).toBe('entry');
  expect(entry.createdAt.toISOString()).toBe('2026-10-26T12:00:00.000Z');
  expect(Object.isFrozen(entry)).toBe(true);
});
test('ledger rehydrate preserves persisted values without replaying creation checks', () => {
  const entry = WalletLedgerEntry.rehydrate(state());
  expect(entry.transactionId).toBe('transaction');
  expect(entry.balanceAfter.toString()).toBe('75.00');
});
