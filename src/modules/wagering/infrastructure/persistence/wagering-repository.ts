import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../../config/infrastructure.module';
import type { AppConfig } from '../../../../config/config';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { DomainError } from '../../../../shared/domain/errors/domain-error';
import {
  isRetryableTransactionError,
  pgCode,
  pgConstraint,
} from '../../../../shared/infrastructure/postgres-error';
import { databaseOperation } from '../../../../shared/infrastructure/database-operation';
import { WagerTransaction } from '../../domain/wager-transaction';
import type { WagerKind } from '../../domain/wager-command';
import type { SubmissionReceipt, WagerFailureCode } from '../../domain/submission-receipt';
import { Money } from '../../../../shared/domain/money';
import { Wallet } from '../../../wallets/domain/wallet';
import type {
  TransactionView,
  WageringSession,
  WageringStore,
} from '../../application/wagering-store';

interface TransactionRow {
  id: string;
  wallet_id: string;
  provider_id: string | null;
  external_transaction_id: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  player_id: string;
  round_id: string | null;
  game_id: string | null;
  kind: string;
  status: TransactionView['status'];
  failure_code: WagerFailureCode | null;
  amount: string;
  currency: string;
  created_at: Date;
  processed_at: Date | null;
  http_status: number | null;
  body: SubmissionReceipt['body'] | null;
}
function receiptFrom(row: TransactionRow): SubmissionReceipt {
  if (row.http_status === 200 && row.body?.status === 'PROCESSED')
    return { httpStatus: 200, body: row.body };
  if (row.http_status === 422 && row.body?.status === 'REJECTED')
    return { httpStatus: 422, body: row.body };
  throw new Error('Inconsistent persisted submission receipt');
}
async function submission(
  em: EntityManager,
  providerId: string,
  key: string,
): Promise<WagerTransaction | undefined> {
  const [row] = await em.execute<TransactionRow[]>(
    `select t.*,t.amount::text as amount,r.http_status,r.body from wagering.transactions t join wagering.submission_receipts r on r.transaction_id=t.id where t.provider_id=? and t.idempotency_key=?`,
    [providerId, key],
  );
  return (
    row &&
    WagerTransaction.rehydrate({
      id: row.id,
      command: {
        providerId: row.provider_id!,
        externalTransactionId: row.external_transaction_id!,
        walletId: row.wallet_id,
        playerId: row.player_id,
        roundId: row.round_id!,
        gameId: row.game_id!,
        kind: row.kind as WagerKind,
        money: Money.rehydrate({ amount: row.amount, currency: row.currency }),
      },
      idempotencyKey: row.idempotency_key!,
      payloadHash: row.request_hash!,
      createdAt: new Date(row.created_at).toISOString(),
      processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : undefined,
      status: row.status,
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
      receipt: receiptFrom(row),
    })
  );
}
async function external(em: EntityManager, providerId: string, id: string): Promise<boolean> {
  return (
    (
      await em.execute(
        'select id from wagering.transactions where provider_id=? and external_transaction_id=?',
        [providerId, id],
      )
    ).length > 0
  );
}
@Injectable()
export class WageringRepository implements WageringStore {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  async transaction<T>(work: (session: WageringSession) => Promise<T>): Promise<T> {
    return databaseOperation(async () => {
      const deadline = Date.now() + this.config.financialDeadlineMs;
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.orm.em.fork().transactional(async (em) => {
            const session = new PostgresWageringSession(em, this.config, deadline);
            const result = await work(session);
            await session.beforeCommit();
            return result;
          });
        } catch (error) {
          const identityRace =
            pgCode(error) === '23505' &&
            ['provider_idempotency_key', 'provider_external_transaction'].includes(
              pgConstraint(error) ?? '',
            );
          // transactional() has rolled back before another attempt reads the winner.
          if (
            attempt < 3 &&
            Date.now() < deadline &&
            (identityRace || isRetryableTransactionError(error))
          )
            continue;
          if (identityRace) throw new DomainError('INFRASTRUCTURE_UNAVAILABLE');
          throw error;
        }
      }
    });
  }
  find(id: string) {
    return this.read('t.id=?', [id]);
  }
  findExternal(providerId: string, id: string) {
    return this.read('t.provider_id=? and t.external_transaction_id=?', [providerId, id]);
  }
  private read(where: string, params: string[]): Promise<TransactionView | undefined> {
    return databaseOperation(async () => {
      const [row] = await this.orm.em
        .fork()
        .execute<
          TransactionRow[]
        >(`select t.*, t.amount::text as amount, w.player_id, r.http_status,r.body from wagering.transactions t join wagering.wallets w on w.id=t.wallet_id left join wagering.submission_receipts r on r.transaction_id=t.id where ${where}`, params);
      return (
        row && {
          transactionId: row.id,
          providerId: row.provider_id,
          externalTransactionId: row.external_transaction_id,
          playerId: row.player_id,
          walletId: row.wallet_id,
          roundId: row.round_id,
          gameId: row.game_id,
          kind: row.kind,
          status: row.status,
          ...(row.failure_code ? { failureCode: row.failure_code } : {}),
          money: Money.rehydrate({ amount: row.amount, currency: row.currency }).toProps(),
          ...(row.body ? { balance: row.body.balance } : {}),
          createdAt: new Date(row.created_at).toISOString(),
          processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : null,
        }
      );
    });
  }
}
class PostgresWageringSession implements WageringSession {
  private limits?: { statement: number; lock: number };
  constructor(
    private readonly em: EntityManager,
    private readonly config: AppConfig,
    private readonly deadline: number,
  ) {}
  private async budget() {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new DomainError('INFRASTRUCTURE_UNAVAILABLE');
    const limits = {
      statement: Math.min(this.config.financialStatementTimeoutMs, remaining),
      lock: Math.min(this.config.financialLockTimeoutMs, remaining),
    };
    if (this.limits?.statement === limits.statement && this.limits.lock === limits.lock) return;
    await this.em.execute(
      "select set_config('statement_timeout',?,true),set_config('lock_timeout',?,true)",
      [`${limits.statement}ms`, `${limits.lock}ms`],
    );
    this.limits = limits;
  }
  beforeCommit() {
    return this.budget();
  }

  private async execute<T extends object[] = Record<string, unknown>[]>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T> {
    await this.budget();
    return this.em.execute<T>(sql, params);
  }
  async lockWallet(id: string) {
    const [row] = await this.execute<
      {
        id: string;
        player_id: string;
        account_id: string;
        currency: string;
        balance: string;
        version: number;
      }[]
    >(
      'select id,player_id,account_id,currency,balance::text,version from wagering.wallets where id=? for update',
      [id],
    );
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
  }
  async findSubmission(providerId: string, key: string) {
    await this.budget();
    return submission(this.em, providerId, key);
  }
  async externalExists(providerId: string, id: string) {
    await this.budget();
    return external(this.em, providerId, id);
  }
  async resources(currency: string) {
    const [row] = await this.execute<{ id: string; now: Date }[]>(
      "select id,clock_timestamp() as now from wagering.accounts where currency=? and kind='GAMING'",
      [currency],
    );
    if (!row) throw new Error('Gaming counterpart is not configured');
    return { counterpartAccountId: row.id, occurredAt: new Date(row.now).toISOString() };
  }
  async save(input: Parameters<WageringSession['save']>[0]) {
    const { transaction, wallet } = input;
    const state = transaction.toProps(),
      command = transaction.command,
      receipt = transaction.getReceipt(),
      occurredAt = state.createdAt;
    await this.execute(
      `insert into wagering.transactions(id,wallet_id,currency,amount,kind,status,provider_id,external_transaction_id,idempotency_key,request_hash,player_id,round_id,game_id,created_at,failure_code,processed_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        transaction.id,
        transaction.walletId,
        transaction.money.currency,
        transaction.money.toProps().amount,
        transaction.kind,
        state.status,
        transaction.providerId,
        transaction.externalTransactionId,
        transaction.idempotencyKey,
        transaction.payloadHash,
        command.playerId,
        command.roundId,
        command.gameId,
        occurredAt,
        state.failureCode ?? null,
        state.processedAt ?? null,
      ],
    );
    if (input.change) {
      const entry = input.change.entry.toProps();
      await this.execute(
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
          occurredAt,
        ],
      );
      await this.execute('update wagering.wallets set balance=?,version=? where id=?', [
        wallet.balance.toProps().amount,
        wallet.version,
        wallet.id,
      ]);
    }
    await this.execute(
      'insert into wagering.submission_receipts(transaction_id,http_status,body) values(?,?,?::jsonb)',
      [transaction.id, receipt.httpStatus, JSON.stringify(receipt.body)],
    );
    const [last] = await this.execute<{ sequence: number }[]>(
      'select coalesce(max(sequence),0)::int as sequence from wagering.outbox where aggregate_id=?',
      [wallet.id],
    );
    let sequence = last!.sequence;
    for (const event of [input.change?.event, transaction.resultEvent]) {
      if (!event) continue;
      const envelope = event.toJSON();
      await this.execute(
        'insert into wagering.outbox(event_id,aggregate_id,transaction_id,sequence,event_type,payload,occurred_at) values(?,?,?,?,?,?::jsonb,?)',
        [
          envelope.eventId,
          wallet.id,
          transaction.id,
          ++sequence,
          envelope.eventType,
          JSON.stringify(envelope),
          occurredAt,
        ],
      );
    }
  }
}
