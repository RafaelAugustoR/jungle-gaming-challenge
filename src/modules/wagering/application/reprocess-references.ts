import { DomainError } from '../../../shared/domain/errors/domain-error';
import { ReferenceRetryPolicy } from '../domain/reference-retry';
import { wagerStepFor } from '../domain/wager-step';
import type { WagerOutcome } from '../domain/wager-transaction';
import type { PendingReferenceCandidate, WageringStore } from './wagering-store';

export class ReprocessReferences {
  constructor(
    private readonly store: WageringStore,
    private readonly policy: ReferenceRetryPolicy,
  ) {}

  async runBatch(limit: number, signal?: AbortSignal): Promise<number> {
    const candidates = await this.store.dueReferences(limit);
    let completed = 0;
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      if (await this.execute(candidate)) completed++;
    }
    return completed;
  }

  execute(candidate: PendingReferenceCandidate): Promise<boolean> {
    return this.store.transaction(async (session) => {
      // Same wallet-first ordering as submissions. Candidate scans hold no locks.
      const wallet = await session.lockWallet(candidate.walletId);
      if (!wallet) throw new DomainError('WALLET_NOT_FOUND');
      const pending = await session.pendingReference(candidate.transactionId);
      if (!pending) return false;
      const { transaction, context } = pending;
      const resources = await session.resources(wallet.currency);
      const now = new Date(resources.occurredAt),
        deadline = new Date(pending.deadline);
      const reference = transaction.command.referenceExternalTransactionId
        ? await session.findReference(
            transaction.providerId,
            transaction.command.referenceExternalTransactionId,
          )
        : undefined;
      let outcome: WagerOutcome = wagerStepFor(transaction.kind).apply(
        transaction,
        wallet,
        { ...resources, referenceDeadline: pending.deadline },
        context,
        reference,
      );
      if (now >= deadline) {
        // A worker delayed past expiry may apply a reference confirmed before the deadline.
        // A late reference must never resurrect an expired operation.
        if (outcome.status === 'PENDING_REFERENCE') {
          outcome = {
            status: 'REJECTED',
            wallet,
            failureCode: reference ? 'REFERENCE_NOT_READY' : 'REFERENCE_NOT_FOUND',
          };
        }
      }
      if (outcome.status === 'PENDING_REFERENCE') {
        await session.rescheduleReference(
          transaction.id,
          this.policy.next(now, pending.attempts + 1, deadline).toISOString(),
        );
        return false;
      }
      transaction.complete(outcome, resources.occurredAt, context);
      await session.savePendingResult(
        { transaction, wallet: outcome.wallet, change: outcome.change },
        resources.occurredAt,
      );
      return true;
    });
  }
}
