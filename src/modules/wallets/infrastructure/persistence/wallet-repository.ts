import { Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { Wallet } from '../../domain/wallet';
import { Money } from '../../../../shared/domain/money';
import type {
  WalletSession,
  WalletStore,
  LedgerEntryView,
  WalletReconciliationView,
} from '../../application/wallet-store';
import { PostgresWalletSession } from './opening-session';
import { databaseOperation } from '../../../../shared/infrastructure/database-operation';

@Injectable()
export class WalletRepository implements WalletStore {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}
  transaction<T>(work: (session: WalletSession) => Promise<T>): Promise<T> {
    return databaseOperation(
      () => this.orm.em.fork().transactional((em) => work(new PostgresWalletSession(em))),
      { wallets_player_id_currency_key: 'WALLET_ALREADY_EXISTS' },
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
          external_transaction_id: string | null;
          kind: string;
          direction: 'CREDIT' | 'DEBIT';
          amount: string;
          currency: string;
          balance_before: string;
          balance_after: string;
          wallet_version: number;
          created_at: Date;
        }>
      >(
        `select l.*, t.external_transaction_id
        from wagering.wallet_ledger l
        join wagering.transactions t on t.id=l.transaction_id
        where l.wallet_id=? and l.wallet_version>? and l.wallet_version<=?
        order by l.wallet_version limit ?`,
        [id, after, upper, limit],
      );
      return rows.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        externalTransactionId: row.external_transaction_id,
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
  reconcile(id: string): Promise<WalletReconciliationView | undefined> {
    return databaseOperation(async () => {
      const [row] = await this.orm.em.fork().execute<
        Array<{
          stored_balance: string;
          calculated_balance: string;
          difference: string;
          consistent: boolean;
          currency: string;
          checked_entries: number;
        }>
      >(
        `select round(w.balance,2)::text as stored_balance, ledger.calculated_balance::text,
          round(w.balance-ledger.calculated_balance,2)::text as difference,
          (w.balance=ledger.calculated_balance) as consistent, w.currency, ledger.checked_entries
        from wagering.wallets w
        cross join lateral (
          select coalesce(sum(case when direction='CREDIT' then amount else -amount end),0) as calculated_balance,
            count(*)::int as checked_entries
          from wagering.wallet_ledger where wallet_id=w.id
        ) ledger
        where w.id=?
        `,
        [id],
      );
      return row
        ? {
            storedBalance: row.stored_balance,
            calculatedBalance: row.calculated_balance,
            difference: row.difference,
            consistent: row.consistent,
            currency: row.currency,
            checkedEntries: row.checked_entries,
          }
        : undefined;
    });
  }
}
