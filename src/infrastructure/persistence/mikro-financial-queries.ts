import { IsolationLevel } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { DomainError } from '../../domain/domain-error';
import { Money } from '../../domain/money';
import type { FinancialQueries, ReconciliationObserver, LedgerView } from '../../application/financial-queries';
import type { RequestContext } from '../../application/financial-ports';
import { WalletSchema,WagerTransactionSchema,type WagerTransactionRow } from './financial-records';
import { ExactAmountType } from './money-mapper';

function uuid(id: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new DomainError('INVALID_PAYLOAD');
}
function money(amount: string,currency: string) { return Money.rehydrate({ amount: new ExactAmountType().convertToJSValue(amount),currency }); }
interface Cursor { version: 1; walletId: string; at: string; id: string }
function decodeCursor(value: unknown,walletId: string): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const decoded = Buffer.from(value,'base64url');
    if (decoded.toString('base64url') !== value) throw new Error();
    const cursor = JSON.parse(decoded.toString('utf8')) as Cursor;
    if (!cursor || Object.keys(cursor).sort().join(',') !== 'at,id,version,walletId'
      || cursor.version !== 1 || cursor.walletId !== walletId || typeof cursor.at !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.at)
      || new Date(cursor.at).toISOString() !== cursor.at.slice(0,23) + 'Z') throw new Error();
    uuid(cursor.id);
    return cursor;
  } catch { throw new DomainError('INVALID_CURSOR'); }
}
function transactionView(row: WagerTransactionRow): Record<string,unknown> {
  return { transactionId: row.id,providerId: row.providerId,externalTransactionId: row.externalTransactionId,
    walletId: row.walletId,playerId: row.playerId,roundId: row.roundId,gameId: row.gameId,kind: row.kind,
    money: { amount: row.amount,currency: row.currency },status: row.status,
    referenceExternalTransactionId: row.referenceExternalTransactionId,referenceTransactionId: row.referenceTransactionId,
    failureCode: row.failureCode,createdAt: row.createdAt.toISOString(),processedAt: row.processedAt?.toISOString() ?? null,
    result: row.resultSnapshot };
}
export class MikroFinancialQueries implements FinancialQueries {
  private readonly table: string;
  constructor(private readonly orm: MikroORM,private readonly observer: ReconciliationObserver) {
    const schema = orm.config.get('schema') ?? 'public';
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('INVALID_QUERY_SCHEMA');
    this.table = `"${schema}"`;
  }
  async wallet(id: string) {
    uuid(id); const row = await this.orm.em.fork().findOne(WalletSchema,{ id });
    if (!row) throw new DomainError('WALLET_NOT_FOUND');
    return { id: row.id,playerId: row.playerId,balance: { amount: row.balance,currency: row.currency },version: row.version };
  }
  async transaction(id: string) {
    uuid(id); const row = await this.orm.em.fork().findOne(WagerTransactionSchema,{ id });
    if (!row) throw new DomainError('TRANSACTION_NOT_FOUND'); return transactionView(row);
  }
  async transactionByExternal(providerId: string,externalTransactionId: string) {
    if (!providerId || providerId !== providerId.trim() || !externalTransactionId || externalTransactionId !== externalTransactionId.trim()) throw new DomainError('INVALID_PAYLOAD');
    const row = await this.orm.em.fork().findOne(WagerTransactionSchema,{ providerId,externalTransactionId });
    if (!row) throw new DomainError('TRANSACTION_NOT_FOUND'); return transactionView(row);
  }
  async ledger(id: string,cursor: unknown,limitInput: unknown) {
    uuid(id); await this.wallet(id);
    if (limitInput !== undefined && (typeof limitInput !== 'string' || !/^[1-9]\d{0,2}$/.test(limitInput))) throw new DomainError('INVALID_PAYLOAD');
    const limit = limitInput === undefined ? 50 : Number(limitInput);
    if (limit > 100) throw new DomainError('INVALID_PAYLOAD');
    const position = decodeCursor(cursor,id);
    interface Row { id: string; transaction_id: string; direction: string; amount: string; currency: string;
      balance_before: string; balance_after: string; wallet_version: number; cursor_at: string }
    const rows = await this.orm.em.getConnection().execute<Row[]>(`select id,transaction_id,direction,amount,currency,
      balance_before,balance_after,wallet_version,
      to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
      from ${this.table}.wallet_ledger where wallet_id=?
      ${position ? 'and (created_at,id) > (?::timestamptz,?::uuid)' : ''}
      order by created_at,id limit ?`,[id,...(position ? [position.at,position.id] : []),limit+1]);
    const page = rows.slice(0,limit); const last = page.at(-1);
    const items: LedgerView[] = page.map(row => ({ id: row.id,transactionId: row.transaction_id,direction: row.direction,
      money: money(row.amount,row.currency).toJSON(),balanceBefore: money(row.balance_before,row.currency).toJSON(),
      balanceAfter: money(row.balance_after,row.currency).toJSON(),walletVersion: row.wallet_version,createdAt: row.cursor_at }));
    const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ version: 1,walletId: id,at: last.cursor_at,id: last.id })).toString('base64url') : null;
    return { items,nextCursor };
  }
  async reconcile(id: string,ctx: RequestContext) {
    uuid(id);
    const result = await this.orm.em.fork().transactional(async em => {
      const row = await em.findOne(WalletSchema,{ id });
      if (!row) throw new DomainError('WALLET_NOT_FOUND');
      const [sum] = await em.execute<{ amount: string; entries: number }[]>(`select coalesce(sum(case direction
        when 'CREDIT' then amount else -amount end),0)::text as amount,count(*)::int as entries
        from ${this.table}.wallet_ledger where wallet_id=?`,[id]);
      if (!sum) throw new Error('RECONCILIATION_QUERY_FAILED');
      const stored = money(row.balance,row.currency); const calculated = money(sum.amount,row.currency);
      return { walletId: id,storedBalance: stored.toJSON(),calculatedBalance: calculated.toJSON(),
        difference: stored.subtract(calculated).toJSON(),consistent: stored.equals(calculated),checkedEntries: sum.entries };
    },{ isolationLevel: IsolationLevel.REPEATABLE_READ });
    if (!result.consistent) this.observer.divergence(id,ctx.correlationId);
    return result;
  }
}
