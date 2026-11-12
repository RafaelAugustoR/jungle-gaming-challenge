import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletSession, WalletContext } from '../../application/wallet-store';
import type { Wallet } from '../../domain/wallet';

export class PostgresWalletSession implements WalletSession {
  constructor(private readonly em: EntityManager) {}
  async openingResources(currency: string) {
    const [counterpart] = await this.em.execute<{ id: string }[]>(
      `select id from wagering.accounts where currency=? and kind='OPENING'`,
      [currency],
    );
    if (!counterpart) throw new Error('Opening counterpart is not configured');
    const [clock] = await this.em.execute<{ now: Date }[]>('select clock_timestamp() as now');
    return { counterpartAccountId: counterpart.id, occurredAt: new Date(clock!.now).toISOString() };
  }
  async saveOpening(result: ReturnType<typeof Wallet.open>, context: WalletContext): Promise<void> {
    const wallet = result.wallet.toProps();
    await this.em.execute(`insert into wagering.accounts(id,currency,kind) values(?,?,'PLAYER')`, [
      wallet.accountId,
      wallet.currency,
    ]);
    await this.em.execute(
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
      await this.em.execute(
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
      await this.em.execute(
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
      await this.em.execute(
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
  }
}
