import { withBackendCancellation } from '../../../../shared/infrastructure/with-backend-cancellation';
import { InboxConflict } from '../../../../messaging/commands/inbox-conflict';
import { Inject, Injectable, Optional } from '@nestjs/common';
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
import {
  restoreSubmissionReceipt,
  type SubmissionReceipt,
  type WagerFailureCode,
} from '../../domain/submission-receipt';
import { Money } from '../../../../shared/domain/money';
import { Wallet } from '../../../wallets/domain/wallet';
import type {
  TransactionView,
  WageringSession,
  WageringStore,
} from '../../application/wagering-store';
import { MetricsRegistry } from '../../../../observability/metrics.module';

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
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  result_balance: string | null;
  http_status: number | null;
  body: SubmissionReceipt['body'] | null;
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
        ...(row.reference_external_transaction_id
          ? { referenceExternalTransactionId: row.reference_external_transaction_id }
          : {}),
        money: Money.rehydrate({ amount: row.amount, currency: row.currency }),
      },
      referenceTransactionId: row.reference_transaction_id ?? undefined,
      idempotencyKey: row.idempotency_key!,
      payloadHash: row.request_hash!,
      createdAt: new Date(row.created_at).toISOString(),
      processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : undefined,
      status: row.status,
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
      receipt: restoreSubmissionReceipt(row.http_status, row.body),
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
    @Optional() @Inject(MetricsRegistry) private readonly metrics?: MetricsRegistry,
  ) {}
  async transaction<T>(
    work: (session: WageringSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return databaseOperation(async () => {
      const deadline = Date.now() + this.config.financialDeadlineMs;
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.orm.em.fork().transactional((em) =>
            withBackendCancellation(em, signal, async () => {
              const session = new PostgresWageringSession(em, this.config, deadline, signal);
              const result = await work(session);
              await session.beforeCommit();
              return result;
            }),
          );
        } catch (error) {
          const code = pgCode(error);
          if (code === '55P03' || code === '40P01')
            this.metrics?.walletLockConflicts.inc({ source: 'financial' });
          const identityRace =
            pgCode(error) === '23505' &&
            ['provider_idempotency_key', 'provider_external_transaction'].includes(
              pgConstraint(error) ?? '',
            );
          // transactional() has rolled back before another attempt reads the winner.
          if (
            !signal?.aborted &&
            attempt < 3 &&
            Date.now() < deadline &&
            (identityRace || isRetryableTransactionError(error))
          ) {
            const reason = identityRace
              ? 'identity_conflict'
              : code === '55P03'
                ? 'lock_timeout'
                : code === '40P01'
                  ? 'deadlock'
                  : 'statement_timeout';
            this.metrics?.wageringTransactionRetries.inc({ reason });
            continue;
          }
          if (identityRace) throw new DomainError('INFRASTRUCTURE_UNAVAILABLE');
          throw error;
        }
      }
    });
  }
  dueReferences(limit: number) {
    return databaseOperation(() =>
      this.orm.em.fork().execute<{ transactionId: string; walletId: string }[]>(
        `select r.transaction_id as "transactionId",t.wallet_id as "walletId" from wagering.reference_retries r join wagering.transactions t on t.id=r.transaction_id
       where r.completed_at is null and r.next_attempt_at<=clock_timestamp() and t.status='PENDING_REFERENCE'
       order by r.next_attempt_at,r.transaction_id limit ?`,
        [limit],
      ),
    );
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
        >(`select t.*, t.amount::text as amount, w.player_id, t.result_balance::text as result_balance from wagering.transactions t join wagering.wallets w on w.id=t.wallet_id where ${where}`, params);
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
          ...(row.reference_external_transaction_id
            ? { referenceExternalTransactionId: row.reference_external_transaction_id }
            : {}),
          ...(row.reference_transaction_id
            ? { referenceTransactionId: row.reference_transaction_id }
            : {}),
          status: row.status,
          ...(row.failure_code ? { failureCode: row.failure_code } : {}),
          money: Money.rehydrate({ amount: row.amount, currency: row.currency }).toProps(),
          ...(row.result_balance !== null
            ? {
                balance: Money.rehydrate({
                  amount: row.result_balance,
                  currency: row.currency,
                }).toProps(),
              }
            : {}),
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
    private readonly signal?: AbortSignal,
  ) {}
  private async budget() {
    this.signal?.throwIfAborted();
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
  async recordInbox(inbox: Parameters<WageringSession['recordInbox']>[0], transactionId: string) {
    const inserted = await this.execute(
      `insert into messaging.command_inbox(consumer_name,message_id,request_hash,transaction_id) values(?,?,?,?) on conflict do nothing returning 1`,
      [inbox.consumerName, inbox.messageId, inbox.hash, transactionId],
    );
    if (inserted.length) return;
    const [row] = await this.execute<{ request_hash: string }[]>(
      'select request_hash from messaging.command_inbox where consumer_name=? and message_id=?',
      [inbox.consumerName, inbox.messageId],
    );
    if (row?.request_hash !== inbox.hash) throw new InboxConflict();
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
  async findReference(providerId: string, externalId: string) {
    const [row] = await this.execute<(TransactionRow & { reversed_by: WagerKind[] })[]>(
      `select t.*,t.amount::text as amount, array(select r.kind from wagering.transactions r where r.reference_transaction_id=t.id and r.status='PROCESSED') as reversed_by from wagering.transactions t where t.provider_id=? and t.external_transaction_id=?`,
      [providerId, externalId],
    );
    return (
      row && {
        id: row.id,
        providerId: row.provider_id!,
        externalTransactionId: row.external_transaction_id!,
        playerId: row.player_id!,
        walletId: row.wallet_id,
        currency: row.currency,
        roundId: row.round_id!,
        kind: row.kind as WagerKind,
        reversedBy: new Set(row.reversed_by),
        processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : undefined,
        status: row.status,
        money: Money.rehydrate({ amount: row.amount, currency: row.currency }),
      }
    );
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
  async pendingReference(id: string) {
    const [row] = await this.execute<
      (TransactionRow & {
        deadline: Date;
        attempts: number;
        correlation_id: string;
        causation_id: string | null;
      })[]
    >(
      `select t.*,s.deadline,s.attempts,s.correlation_id,s.causation_id
       from wagering.transactions t join wagering.reference_retries s on s.transaction_id=t.id
       where t.id=? and t.status='PENDING_REFERENCE' and s.completed_at is null and s.next_attempt_at<=clock_timestamp()`,
      [id],
    );
    if (!row) return undefined;
    const transaction = await submission(this.em, row.provider_id!, row.idempotency_key!);
    if (!transaction) throw new Error('Pending submission receipt is missing');
    return {
      transaction,
      deadline: new Date(row.deadline).toISOString(),
      attempts: row.attempts,
      context: {
        correlationId: row.correlation_id,
        ...(row.causation_id ? { causationId: row.causation_id } : {}),
      },
    };
  }
  async rescheduleReference(id: string, nextAttemptAt: string) {
    await this.execute(
      'update wagering.reference_retries set attempts=attempts+1,next_attempt_at=? where transaction_id=? and completed_at is null',
      [nextAttemptAt, id],
    );
  }
  async referenceSchedule(id: string) {
    const [row] = await this.execute<{ attempts: number; now: Date }[]>(
      `select r.attempts,clock_timestamp() as now from wagering.reference_retries r join wagering.transactions t on t.id=r.transaction_id
       where r.transaction_id=? and r.completed_at is null and r.next_attempt_at<=clock_timestamp() and t.status='PENDING_REFERENCE' for update of r skip locked`,
      [id],
    );
    return (
      row && {
        attempts: row.attempts,
        now: new Date(row.now).toISOString(),
      }
    );
  }
  async scheduleReference(
    id: string,
    schedule: { deadline: string; nextAttemptAt: string },
    context: { correlationId: string; causationId?: string },
  ) {
    await this.execute(
      `insert into wagering.reference_retries(transaction_id,deadline,next_attempt_at,correlation_id,causation_id) values(?,?,?,?,?)`,
      [
        id,
        schedule.deadline,
        schedule.nextAttemptAt,
        context.correlationId,
        context.causationId ?? null,
      ],
    );
  }
  async save(input: Parameters<WageringSession['save']>[0]) {
    const { transaction, wallet } = input,
      state = transaction.toProps(),
      command = transaction.command,
      receipt = transaction.getReceipt();
    await this.execute(
      `insert into wagering.transactions(id,wallet_id,currency,amount,kind,status,provider_id,external_transaction_id,idempotency_key,request_hash,player_id,round_id,game_id,created_at,failure_code,processed_at,reference_external_transaction_id,reference_transaction_id,result_balance) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        state.createdAt,
        state.failureCode ?? null,
        state.processedAt ?? null,
        command.referenceExternalTransactionId ?? null,
        state.referenceTransactionId ?? null,
        wallet.balance.toProps().amount,
      ],
    );
    await this.execute(
      'insert into wagering.submission_receipts(transaction_id,http_status,body) values(?,?,?::jsonb)',
      [transaction.id, receipt.httpStatus, JSON.stringify(receipt.body)],
    );
    await this.saveFinancialEffects(input, state.createdAt);
  }
  async savePendingResult(input: Parameters<WageringSession['savePendingResult']>[0], at: string) {
    const { transaction, wallet } = input,
      state = transaction.toProps();
    await this.execute(
      `update wagering.transactions set status=?,failure_code=?,processed_at=?,reference_transaction_id=?,result_balance=? where id=?`,
      [
        state.status,
        state.failureCode ?? null,
        state.processedAt ?? null,
        state.referenceTransactionId ?? null,
        wallet.balance.toProps().amount,
        transaction.id,
      ],
    );
    await this.execute(
      `update wagering.reference_retries set completed_at=?,next_attempt_at=null,attempts=attempts+1 where transaction_id=?`,
      [at, transaction.id],
    );
    await this.saveFinancialEffects(input, at);
  }
  private async saveFinancialEffects(
    input: Parameters<WageringSession['save']>[0],
    occurredAt: string,
  ) {
    const { transaction, wallet } = input;
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
