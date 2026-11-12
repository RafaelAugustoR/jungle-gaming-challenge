import MoneyDecimal from 'decimal.js';
import { Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../../shared/domain/money';
import { apiError } from '../../../shared/rest/api-error';
import { Wallet, type WalletProps } from '../domain/wallet';
import { JournalEntry } from '../domain/journal-entry';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';

interface WalletRow {
  id: string;
  player_id: string;
  balance: string;
  currency: string;
  version: number;
}
const toWallet = (row: WalletRow) =>
  Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    balance: Money.create(new MoneyDecimal(row.balance).toFixed(2), row.currency).toProps().amount,
    currency: row.currency,
    version: row.version,
  });
const response = (wallet: Wallet) => {
  const { balance, currency, ...props } = wallet.toProps();
  return { ...props, balance: { amount: balance, currency } };
};
const validId = (id: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw apiError(400, 'INVALID_PAYLOAD');
};

@Injectable()
export class Wallets {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}
  async create(body: unknown, context: { actorId: string; correlationId: string }) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw apiError(400, 'INVALID_PAYLOAD');
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => !['playerId', 'initialBalance'].includes(key)) ||
      typeof input.playerId !== 'string' ||
      !input.initialBalance ||
      typeof input.initialBalance !== 'object' ||
      Array.isArray(input.initialBalance)
    )
      throw apiError(400, 'INVALID_PAYLOAD');
    const initial = input.initialBalance as Record<string, unknown>;
    if (
      Object.keys(initial).some((key) => !['amount', 'currency'].includes(key)) ||
      initial.currency !== 'BRL'
    )
      throw apiError(400, 'INVALID_PAYLOAD');
    let money: Money;
    let wallet: WalletProps;
    try {
      money = Money.create(initial.amount as string, initial.currency);
      wallet = Wallet.create(input.playerId, money).toProps();
    } catch (error) {
      throw apiError(400, error instanceof Error ? error.message : 'INVALID_PAYLOAD');
    }
    try {
      await this.orm.em.fork().transactional(async (em) => {
        const accountId = crypto.randomUUID();
        await em.execute(
          `insert into wagering.accounts(id, currency, kind) values (?, ?, 'PLAYER')`,
          [accountId, wallet.currency],
        );
        await em.execute(
          'insert into wagering.wallets(id, player_id, currency, balance, version, account_id) values (?, ?, ?, ?, 1, ?)',
          [wallet.id, wallet.playerId, wallet.currency, wallet.balance, accountId],
        );
        if (!money.isZero()) {
          const transactionId = crypto.randomUUID();
          const [counterpart] = await em.execute<{ id: string }[]>(
            `select id from wagering.accounts where currency = ? and kind = 'OPENING'`,
            [wallet.currency],
          );
          const [opening] = await em.execute<{ created_at: Date }[]>(
            `insert into wagering.openings(id, wallet_id, currency, amount) values (?, ?, ?, ?) returning created_at`,
            [transactionId, wallet.id, wallet.currency, wallet.balance],
          );
          const entry = JournalEntry.create({
            walletId: wallet.id,
            transactionId,
            debitAccountId: counterpart!.id,
            creditAccountId: accountId,
            money,
            balanceBefore: Money.create('0.00', wallet.currency),
            balanceAfter: money,
            direction: 'CREDIT',
            walletVersion: 1,
          }).toProps();
          await em.execute(
            `insert into wagering.journal(id, transaction_id, wallet_id, currency, amount, debit_account_id, credit_account_id, balance_before, balance_after, wallet_version) values (?, ?, ?, ?, ?, ?, ?, 0, ?, 1)`,
            [
              entry.id,
              entry.transactionId,
              entry.walletId,
              entry.currency,
              entry.amount,
              entry.debitAccountId,
              entry.creditAccountId,
              entry.balanceAfter,
            ],
          );
          const event = WalletBalanceChanged.create(
            {
              walletId: wallet.id,
              transactionId,
              direction: 'CREDIT',
              money: money.toProps(),
              balanceBefore: { amount: '0.00', currency: wallet.currency },
              balanceAfter: money.toProps(),
              walletVersion: 1,
            },
            new Date(opening!.created_at).toISOString(),
            { correlationId: context.correlationId },
          );
          const payload = { ...event.toJSON(), actorId: context.actorId };
          await em.execute(
            `insert into wagering.outbox(event_id, aggregate_id, transaction_id, sequence, event_type, payload) values (?, ?, ?, 1, ?, ?::jsonb)`,
            [event.eventId, wallet.id, transactionId, event.eventType, JSON.stringify(payload)],
          );
        }
      });
      return response(Wallet.rehydrate(wallet));
    } catch (error) {
      throw this.databaseError(error);
    }
  }
  async get(id: string) {
    validId(id);
    try {
      const [row] = await this.orm.em
        .fork()
        .execute<
          WalletRow[]
        >('select id, player_id, currency, balance::text, version from wagering.wallets where id = ?', [id]);
      if (!row) throw apiError(404, 'WALLET_NOT_FOUND');
      return response(toWallet(row));
    } catch (error) {
      throw this.databaseError(error);
    }
  }
  async ledger(id: string, cursor?: string, limitValue?: string) {
    validId(id);
    const limit = limitValue === undefined ? 50 : Number(limitValue);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (limitValue !== undefined && !/^\d+$/.test(limitValue))
    )
      throw apiError(400, 'INVALID_PAYLOAD');
    const wallet = await this.get(id);
    let after = 0,
      upper = wallet.version;
    if (cursor !== undefined) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (
          parsed.walletId !== id ||
          !Number.isInteger(parsed.after) ||
          !Number.isInteger(parsed.upper) ||
          parsed.after < 0 ||
          parsed.upper > wallet.version ||
          parsed.after >= parsed.upper
        )
          throw new Error();
        after = parsed.after;
        upper = parsed.upper;
      } catch {
        throw apiError(400, 'INVALID_PAYLOAD');
      }
    }
    try {
      const rows = await this.orm.em.fork().execute<
        Array<{
          id: string;
          transaction_id: string;
          kind: string;
          direction: string;
          amount: string;
          currency: string;
          balance_before: string;
          balance_after: string;
          wallet_version: number;
          created_at: Date;
        }>
      >(`select * from wagering.wallet_ledger where wallet_id = ? and wallet_version > ? and wallet_version <= ? order by wallet_version limit ?`, [id, after, upper, limit + 1]);
      const entries = rows.slice(0, limit).map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        kind: row.kind,
        direction: row.direction,
        amount: new MoneyDecimal(row.amount).toFixed(2),
        currency: row.currency,
        balanceBefore: new MoneyDecimal(row.balance_before).toFixed(2),
        balanceAfter: new MoneyDecimal(row.balance_after).toFixed(2),
        walletVersion: row.wallet_version,
        createdAt: new Date(row.created_at).toISOString(),
      }));
      const nextCursor =
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({ walletId: id, after: entries.at(-1)!.walletVersion, upper }),
            ).toString('base64url')
          : null;
      return { entries, nextCursor };
    } catch (error) {
      throw this.databaseError(error);
    }
  }
  private databaseError(error: unknown): Error {
    if (error instanceof Error && 'getStatus' in error) return error;
    const code = (error as { code?: string }).code;
    if (code === '23505') return apiError(409, 'WALLET_ALREADY_EXISTS');
    if (
      code?.startsWith('08') ||
      ['57P01', '57P03', '53300', '40001', '40P01', '55P03', 'ECONNREFUSED', 'ETIMEDOUT'].includes(
        code ?? '',
      )
    )
      return apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
    return error instanceof Error ? error : new Error('Database failure');
  }
}
