import { observed, type ProcessingObserver } from './observed';
import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { EventContext } from '../../../shared/domain/events/integration-event';
import { WagerTransaction } from '../domain/wager-transaction';
import { InboxMessage } from '../../../messaging/domain/inbox-message';
import type { WagerCommand, WagerKind } from '../domain/wager-command';
import { WagerPayload } from '../domain/wager-payload';
import { ReferenceRetryPolicy } from '../domain/reference-retry';
import { settleWager } from './settle-wager';
import type { SubmissionReceipt } from '../domain/submission-receipt';
import type { SubmissionExecution, WageringSession, WageringStore } from './wagering-store';

export type SubmissionObserver = ProcessingObserver<
  SubmissionExecution['channel'],
  WagerKind,
  SubmissionReceipt['body']['status']
>;

function replay(existing: WagerTransaction, hash: string): SubmissionReceipt {
  if (!existing.matchesPayload(hash)) throw new DomainError('IDEMPOTENCY_CONFLICT');
  return existing.getReceipt(true);
}
export class SubmitWagerTransaction {
  constructor(
    private readonly store: WageringStore,
    private readonly knownProviders: ReadonlySet<string>,
    private readonly policy: ReferenceRetryPolicy,
    private readonly observer: SubmissionObserver = {},
  ) {}
  async execute(
    input: WagerCommand,
    key: string,
    context: EventContext,
    execution: SubmissionExecution,
  ): Promise<SubmissionReceipt> {
    return observed(
      this.observer,
      { channel: execution.channel, operation: input.kind },
      async () => {
        if (!this.knownProviders.has(input.providerId)) throw new DomainError('UNKNOWN_PROVIDER');
        const payload = WagerPayload.create(input);
        const receipt = await this.store.transaction(async (session) => {
          const result = await this.submit(session, payload, key, context);
          if (execution.inbox)
            await session.recordInbox(
              InboxMessage.record({
                ...execution.inbox,
                transactionId: result.body.transactionId,
              }),
            );
          return result;
        }, execution.signal);
        return {
          value: receipt,
          operation: input.kind,
          status: receipt.body.status,
          idempotentReplay: receipt.body.idempotentReplay,
        };
      },
    );
  }

  private async submit(
    session: WageringSession,
    payload: WagerPayload,
    key: string,
    context: EventContext,
  ): Promise<SubmissionReceipt> {
    const command = payload.command;
    // Read-only preflight makes an accepted key authoritative even for a changed wallet.
    const accepted = await session.findSubmission(command.providerId, key);
    if (accepted) return replay(accepted, payload.hash);
    const wallet = await session.lockWallet(command.walletId);
    if (!wallet) throw new DomainError('WALLET_NOT_FOUND');
    // Recheck after locking: another process may have committed while we waited.
    const existing = await session.findSubmission(command.providerId, key);
    if (existing) return replay(existing, payload.hash);
    if (await session.externalExists(command.providerId, command.externalTransactionId))
      throw new DomainError('EXTERNAL_TRANSACTION_CONFLICT');
    if (wallet.playerId !== command.playerId) throw new DomainError('PLAYER_MISMATCH');
    if (wallet.currency !== command.money.currency) throw new DomainError('CURRENCY_MISMATCH');
    const { transaction, outcome, occurredAt } = await settleWager(
      session,
      (at) =>
        WagerTransaction.create({
          payload,
          idempotencyKey: key,
          createdAt: at,
        }),
      wallet,
      context,
    );
    transaction.complete(outcome, occurredAt, context);
    await session.save({ transaction, wallet: outcome.wallet, change: outcome.change });
    if (outcome.status === 'PENDING_REFERENCE') {
      const acceptedAt = new Date(occurredAt),
        deadline = this.policy.deadline(acceptedAt);
      await session.scheduleReference(
        transaction.id,
        {
          deadline: deadline.toISOString(),
          nextAttemptAt: this.policy.next(acceptedAt, 0, deadline).toISOString(),
        },
        context,
      );
    }
    return transaction.getReceipt();
  }
}
