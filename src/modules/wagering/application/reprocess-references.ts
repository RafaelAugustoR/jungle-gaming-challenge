import type { SubmissionObserver } from './submit-wager-transaction';
import { DomainError } from '../../../shared/domain/errors/domain-error';
import { ReferenceRetryPolicy } from '../domain/reference-retry';
import { settleWager } from './settle-wager';
import type { PendingReferenceCandidate, WageringStore } from './wagering-store';

export class ReprocessReferences {
  constructor(
    private readonly store: WageringStore,
    private readonly policy: ReferenceRetryPolicy,
    private readonly onError: (
      candidate: PendingReferenceCandidate,
      error: unknown,
    ) => void = () => {},
    private readonly observer: SubmissionObserver = {},
  ) {}

  async runBatch(limit: number, signal?: AbortSignal): Promise<number> {
    const candidates = await this.store.dueReferences(limit);
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
          await this.store.transaction(async (session) => {
            const schedule = await session.referenceSchedule(candidate.transactionId);
            if (!schedule) return;
            const now = new Date(schedule.now);
            // Infrastructure backoff must remain in the future even after business TTL.
            const horizon = new Date(now.getTime() + this.policy.options.maxMs);
            await session.rescheduleReference(
              candidate.transactionId,
              this.policy.next(now, schedule.attempts + 1, horizon).toISOString(),
            );
          });
        } catch (deferralError) {
          this.onError(candidate, deferralError);
        }
      }
    }
    return completed;
  }

  async execute(candidate: PendingReferenceCandidate): Promise<boolean> {
    const startedAt = performance.now();
    let operation = 'unknown';
    let status = 'skipped';
    try {
      const completed = await this.store.transaction(async (session) => {
        // Same wallet-first ordering as submissions. Candidate scans hold no locks.
        const wallet = await session.lockWallet(candidate.walletId);
        if (!wallet) throw new DomainError('WALLET_NOT_FOUND');
        const pending = await session.pendingReference(candidate.transactionId);
        if (!pending) return false;
        const { transaction, context } = pending;
        operation = transaction.kind;
        const { outcome, occurredAt } = await settleWager(
          session,
          () => transaction,
          wallet,
          context,
          pending.deadline,
        );
        status = outcome.status;
        const now = new Date(occurredAt),
          deadline = new Date(pending.deadline);
        if (outcome.status === 'PENDING_REFERENCE') {
          await session.rescheduleReference(
            transaction.id,
            this.policy.next(now, pending.attempts + 1, deadline).toISOString(),
          );
          return false;
        }
        transaction.complete(outcome, occurredAt, context);
        await session.savePendingResult(
          { transaction, wallet: outcome.wallet, change: outcome.change },
          occurredAt,
        );
        return true;
      });
      this.observer.completed?.({
        operation,
        channel: 'reference',
        status,
        durationSeconds: (performance.now() - startedAt) / 1000,
        idempotentReplay: false,
      });
      return completed;
    } catch (error) {
      this.observer.failed?.({
        operation,
        channel: 'reference',
        durationSeconds: (performance.now() - startedAt) / 1000,
      });
      throw error;
    }
  }
}
