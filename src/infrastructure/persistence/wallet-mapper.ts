import { Wallet } from '../../domain/wallet';
import { MoneyMapper } from './money-mapper';
import type { WalletRow } from './financial-records';

export const WalletMapper = {
  toRow(wallet: Wallet): WalletRow {
    return { id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
      balance: MoneyMapper.toColumns(wallet.balance).amount, version: wallet.version,
      createdAt: wallet.createdAt, updatedAt: wallet.updatedAt };
  },
  fromRow(row: WalletRow): Wallet {
    return Wallet.rehydrate({ ...row, balance: MoneyMapper.fromColumns({ amount: row.balance, currency: row.currency }) });
  },
};
