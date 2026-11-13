import { observed, type ProcessingObserver } from './observed';
import type { WagerKind } from '../domain/wager-command';
import type { TransactionStatus } from '../domain/wager-transaction';
import { DomainError } from '../../../shared/domain/errors/domain-error';
import { ReferenceRetryPolicy } from '../domain/reference-retry';
import { settleWager } from './settle-wager';
import type { PendingReferenceCandidate, WageringStore } from './wagering-store';

export interface ReferenceObserver extends ProcessingObserver<
  'reference',
  WagerKind | 'unknown',
  TransactionStatus | 'skipped'
> {
  rescheduled?(reason: 'reference_pending' | 'processing_unavailable'): void;
  batchFailed?(): void;
}

export class ReprocessReferences {
  constructor(
    private readonly store: WageringStore,
    private readonly policy: ReferenceRetryPolicy,
    private readonly onError: (
      candidate: PendingReferenceCandidate,
      error: unknown,
    ) => void = () => {},
    private readonly observer: ReferenceObserver = {},
  ) {}

  async runBatch(limit: number, signal?: AbortSignal): Promise<number> {
    const candidates = await this.store.dueReferences(limit).catch((error) => {
      this.observer.batchFailed?.();
      throw error;
    });
    let completed = 0;
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      try {
        if (await this.execute(candidate)) completed++;
      } catch (error) {
        this.onError(candidate, error);
        // Financial work has rolled back. Deferral must not require the failed receipt,
        // wallet lock or reference lookup, and must never make a terminal decision.
        try {
          const rescheduled = await this.store.transaction(async (session) => {
            const schedule = await session.referenceSchedule(candidate.transactionId);
            if (!schedule) return false;
            const now = new Date(schedule.now);
            // Infrastructure backoff must remain in the future even after business TTL.
            const horizon = new Date(now.getTime() + this.policy.options.maxMs);
            await session.rescheduleReference(
              candidate.transactionId,
              this.policy.next(now, schedule.attempts + 1, horizon).toISOString(),
            );
            return true;
          });
          if (rescheduled) this.observer.rescheduled?.('processing_unavailable');
        } catch (deferralError) {
          this.onError(candidate, deferralError);
        }
      }
    }
    return completed;
  }

  async execute(candidate: PendingReferenceCandidate): Promise<boolean> {
    const result = await observed(
      this.observer,
      { channel: 'reference', operation: 'unknown' },
      () =>
        this.store.transaction(async (session) => {
          const wallet = await session.lockWallet(candidate.walletId);
          if (!wallet) throw new DomainError('WALLET_NOT_FOUND');
          const pending = await session.pendingReference(candidate.transactionId);
          if (!pending)
            return {
              value: { completed: false, rescheduled: false },
              operation: 'unknown' as const,
              status: 'skipped' as const,
            };
          const { transaction, context } = pending;
          const { outcome, occurredAt } = await settleWager(
            session,
            () => transaction,
            wallet,
            context,
            pending.deadline,
          );
          if (outcome.status === 'PENDING_REFERENCE') {
            await session.rescheduleReference(
              transaction.id,
              this.policy
                .next(new Date(occurredAt), pending.attempts + 1, new Date(pending.deadline))
                .toISOString(),
            );
            return {
              value: { completed: false, rescheduled: true },
              operation: transaction.kind,
              status: outcome.status,
            };
          }
          transaction.complete(outcome, occurredAt, context);
          await session.savePendingResult(
            { transaction, wallet: outcome.wallet, change: outcome.change },
            occurredAt,
          );
          return {
            value: { completed: true, rescheduled: false },
            operation: transaction.kind,
            status: outcome.status,
          };
        }),
    );
    if (result.rescheduled) this.observer.rescheduled?.('reference_pending');
    return result.completed;
  }
}
