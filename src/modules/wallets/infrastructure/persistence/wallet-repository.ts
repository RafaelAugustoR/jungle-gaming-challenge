import { Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { Wallet } from '../../domain/wallet';
import { Money } from '../../../../shared/domain/money';
import type { WalletSession, WalletStore, LedgerEntryView } from '../../application/wallet-store';
import { PostgresWalletSession } from './opening-session';
import { databaseOperation } from './database-error';

@Injectable()
export class WalletRepository implements WalletStore {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}
  transaction<T>(work: (session: WalletSession) => Promise<T>): Promise<T> {
    return databaseOperation(() =>
      this.orm.em.fork().transactional((em) => work(new PostgresWalletSession(em))),
    );
  }
  find(id: string): Promise<Wallet | undefined> {
    return databaseOperation(async () => {
      const [row] = await this.orm.em.fork().execute<
        Array<{
          id: string;
          player_id: string;
          account_id: string;
          currency: string;
          balance: string;
          version: number;
        }>
      >('select id,player_id,account_id,currency,balance::text,version from wagering.wallets where id=?', [id]);
      return (
        row &&
        Wallet.rehydrate({
          id: row.id,
          playerId: row.player_id,
          accountId: row.account_id,
          currency: row.currency,
          balance: row.balance,
          version: row.version,
        })
      );
    });
  }
  ledger(id: string, after: number, upper: number, limit: number): Promise<LedgerEntryView[]> {
    return databaseOperation(async () => {
      const rows = await this.orm.em.fork().execute<
        Array<{
          id: string;
          transaction_id: string;
          kind: string;
          direction: 'CREDIT' | 'DEBIT';
          amount: string;
          currency: string;
          balance_before: string;
          balance_after: string;
          wallet_version: number;
          created_at: Date;
        }>
      >('select * from wagering.wallet_ledger where wallet_id=? and wallet_version>? and wallet_version<=? order by wallet_version limit ?', [id, after, upper, limit]);
      return rows.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        kind: row.kind,
        direction: row.direction,
        amount: Money.rehydrate({ amount: row.amount, currency: row.currency }).toProps().amount,
        currency: row.currency,
        balanceBefore: Money.rehydrate({
          amount: row.balance_before,
          currency: row.currency,
        }).toProps().amount,
        balanceAfter: Money.rehydrate({
          amount: row.balance_after,
          currency: row.currency,
        }).toProps().amount,
        walletVersion: row.wallet_version,
        createdAt: new Date(row.created_at).toISOString(),
      }));
    });
  }
}
