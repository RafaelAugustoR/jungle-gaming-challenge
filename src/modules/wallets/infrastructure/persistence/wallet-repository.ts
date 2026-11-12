import { Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { Wallet } from '../../domain/wallet';
import { Money } from '../../../../shared/domain/money';
import type {
  CreateWalletCommand,
  WalletContext,
  WalletStore,
  LedgerEntryView,
} from '../../application/wallet-store';
import { databaseOperation } from './database-error';

@Injectable()
export class WalletRepository implements WalletStore {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}
  open(command: CreateWalletCommand, context: WalletContext): Promise<Wallet> {
    return databaseOperation(() =>
      this.orm.em.fork().transactional(async (em) => {
        const [counterpart] = await em.execute<{ id: string }[]>(
          `select id from wagering.accounts where currency=? and kind='OPENING'`,
          [command.initialBalance.currency],
        );
        if (!counterpart) throw new Error('Opening counterpart is not configured');
        const [clock] = await em.execute<{ now: Date }[]>('select clock_timestamp() as now');
        const result = Wallet.open({
          ...command,
          accountId: crypto.randomUUID(),
          counterpartAccountId: counterpart.id,
          occurredAt: new Date(clock!.now).toISOString(),
          context,
        });
        const wallet = result.wallet.toProps();
        await em.execute(`insert into wagering.accounts(id,currency,kind) values(?,?,'PLAYER')`, [
          wallet.accountId,
          wallet.currency,
        ]);
        await em.execute(
          `insert into wagering.wallets(id,player_id,currency,balance,version,account_id) values(?,?,?,?,?,?)`,
          [
            wallet.id,
            wallet.playerId,
            wallet.currency,
            wallet.balance,
            wallet.version,
            wallet.accountId,
          ],
        );
        if (result.transaction && result.entry && result.event) {
          const transaction = result.transaction;
          const entry = result.entry.toProps();
          await em.execute(
            `insert into wagering.transactions(id,wallet_id,currency,amount,kind,status,created_at) values(?,?,?,?,?,?,?)`,
            [
              transaction.id,
              transaction.walletId,
              transaction.currency,
              transaction.amount,
              transaction.kind,
              transaction.status,
              transaction.createdAt,
            ],
          );
          await em.execute(
            `insert into wagering.journal(id,transaction_id,wallet_id,currency,amount,debit_account_id,credit_account_id,balance_before,balance_after,wallet_version,created_at) values(?,?,?,?,?,?,?,?,?,?,?)`,
            [
              entry.id,
              entry.transactionId,
              entry.walletId,
              entry.currency,
              entry.amount,
              entry.debitAccountId,
              entry.creditAccountId,
              entry.balanceBefore,
              entry.balanceAfter,
              entry.walletVersion,
              transaction.createdAt,
            ],
          );
          const event = result.event.toJSON();
          await em.execute(
            `insert into wagering.outbox(event_id,aggregate_id,transaction_id,sequence,event_type,payload,occurred_at) values(?,?,?,?,?,?::jsonb,?)`,
            [
              event.eventId,
              event.aggregateId,
              entry.transactionId,
              1,
              event.eventType,
              JSON.stringify({ ...event, actorId: context.actorId }),
              event.occurredAt,
            ],
          );
        }
        return result.wallet;
      }),
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
