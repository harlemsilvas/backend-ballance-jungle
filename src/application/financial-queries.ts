import type { MoneyProps } from '../domain/money';
import type { RequestContext } from './financial-ports';
export interface WalletView { id: string; playerId: string; balance: MoneyProps; version: number }
export interface LedgerView {
  id: string; transactionId: string; direction: string; money: MoneyProps;
  balanceBefore: MoneyProps; balanceAfter: MoneyProps; walletVersion: number; createdAt: string;
}
export interface LedgerPage { items: LedgerView[]; nextCursor: string | null }
export interface ReconciliationView {
  walletId: string; storedBalance: MoneyProps; calculatedBalance: MoneyProps;
  difference: MoneyProps; consistent: boolean; checkedEntries: number;
}
export interface FinancialQueries {
  wallet(id: string): Promise<WalletView>;
  transaction(id: string): Promise<Record<string,unknown>>;
  transactionByExternal(provider: string,external: string): Promise<Record<string,unknown>>;
  ledger(id: string,cursor: unknown,limit: unknown): Promise<LedgerPage>;
  reconcile(id: string,ctx: RequestContext): Promise<ReconciliationView>;
}
export interface ReconciliationObserver { divergence(walletId: string,correlationId: string | undefined): void }
