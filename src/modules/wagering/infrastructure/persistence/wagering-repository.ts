import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../../config/infrastructure.module';
import type { AppConfig } from '../../../../config/config';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { DomainError } from '../../../../shared/domain/errors/domain-error';
import {
  isTransientPostgresError,
  isRetryableTransactionError,
} from '../../../../shared/infrastructure/postgres-error';
import { Money } from '../../../../shared/domain/money';
import { Wallet } from '../../../wallets/domain/wallet';
import type {
  AcceptedSubmission,
  TransactionView,
  WageringSession,
  WageringStore,
} from '../../application/wagering-store';

async function submission(
  em: EntityManager,
  providerId: string,
  key: string,
): Promise<AcceptedSubmission | undefined> {
  const [row] = await em.execute<
    { request_hash: string; http_status: 200 | 422; body: AcceptedSubmission['receipt']['body'] }[]
  >(
    `select t.request_hash, r.http_status, r.body from wagering.transactions t join wagering.submission_receipts r on r.transaction_id=t.id where t.provider_id=? and t.idempotency_key=?`,
    [providerId, key],
  );
  return (
    row && { hash: row.request_hash, receipt: { httpStatus: row.http_status, body: row.body } }
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
async function query<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (isTransientPostgresError(error)) throw new DomainError('INFRASTRUCTURE_UNAVAILABLE');
    throw error;
  }
}
@Injectable()
export class WageringRepository implements WageringStore {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  async transaction<T>(work: (session: WageringSession) => Promise<T>): Promise<T> {
    return query(async () => {
      const deadline = Date.now() + this.config.financialDeadlineMs;
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.orm.em.fork().transactional(async (em) => {
            await em.execute("select set_config('application_name',?,true)", [
              `wagering-api-${process.pid}`,
            ]);
            return work(new PostgresWageringSession(em, this.config, deadline));
          });
        } catch (error) {
          const { code, constraint } = error as { code?: string; constraint?: string };
          if (
            code === '23505' &&
            ['provider_idempotency_key', 'provider_external_transaction'].includes(constraint ?? '')
          )
            throw new DomainError('SUBMISSION_RACE');
          if (attempt < 3 && Date.now() < deadline && isRetryableTransactionError(error)) continue;
          throw error;
        }
      }
    });
  }
  findSubmission(providerId: string, key: string) {
    return query(() => submission(this.orm.em.fork(), providerId, key));
  }
  externalExists(providerId: string, id: string) {
    return query(() => external(this.orm.em.fork(), providerId, id));
  }
  find(id: string) {
    return this.read('t.id=?', [id]);
  }
  findExternal(providerId: string, id: string) {
    return this.read('t.provider_id=? and t.external_transaction_id=?', [providerId, id]);
  }
  private read(where: string, params: string[]): Promise<TransactionView | undefined> {
    return query(async () => {
      const [row] = await this.orm.em.fork().execute<
        Array<{
          id: string;
          wallet_id: string;
          provider_id: string | null;
          external_transaction_id: string | null;
          player_id: string;
          round_id: string | null;
          game_id: string | null;
          kind: string;
          status: TransactionView['status'];
          failure_code: string | null;
          amount: string;
          currency: string;
          created_at: Date;
          processed_at: Date | null;
          body: AcceptedSubmission['receipt']['body'] | null;
        }>
      >(`select t.*, t.amount::text as amount, w.player_id, r.body from wagering.transactions t join wagering.wallets w on w.id=t.wallet_id left join wagering.submission_receipts r on r.transaction_id=t.id where ${where}`, params);
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
  constructor(
    private readonly em: EntityManager,
    private readonly config: AppConfig,
    private readonly deadline: number,
  ) {}
  private async budget() {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new DomainError('INFRASTRUCTURE_UNAVAILABLE');
    await this.em.execute(
      "select set_config('statement_timeout',?,true),set_config('lock_timeout',?,true)",
      [
        `${Math.min(this.config.financialStatementTimeoutMs, remaining)}ms`,
        `${Math.min(this.config.financialLockTimeoutMs, remaining)}ms`,
      ],
    );
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
    const { command, transaction, wallet, receipt, occurredAt } = input;
    await this.execute(
      `insert into wagering.transactions(id,wallet_id,currency,amount,kind,status,provider_id,external_transaction_id,idempotency_key,request_hash,player_id,round_id,game_id,created_at) values(?,?,?,?,?,'PENDING',?,?,?,?,?,?,?,?)`,
      [
        transaction.id,
        wallet.id,
        command.money.currency,
        command.money.toProps().amount,
        command.kind,
        command.providerId,
        command.externalTransactionId,
        input.key,
        input.hash,
        command.playerId,
        command.roundId,
        command.gameId,
        occurredAt,
      ],
    );
    const state = transaction.toProps();
    await this.execute(
      'update wagering.transactions set status=?,failure_code=?,processed_at=? where id=?',
      [
        state.status,
        state.failureCode ?? null,
        state.status === 'PROCESSED' ? occurredAt : null,
        transaction.id,
      ],
    );
    if (input.movement) {
      const entry = input.movement.entry.toProps();
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
    for (const event of [input.movement?.balanceEvent, input.resultEvent]) {
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
