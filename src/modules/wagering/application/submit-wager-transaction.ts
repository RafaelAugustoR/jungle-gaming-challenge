import { createHash } from 'node:crypto';
import type { SubmissionExecution } from './wagering-store';
import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { EventContext } from '../../../shared/domain/events/integration-event';
import { WagerTransaction } from '../domain/wager-transaction';
import type { WagerCommand } from '../domain/wager-command';
import { WagerPayload } from '../domain/wager-payload';
import { ReferenceRetryPolicy } from '../domain/reference-retry';
import { settleWager } from './settle-wager';
import type { SubmissionReceipt } from '../domain/submission-receipt';
import type { WageringStore } from './wagering-store';

function replay(existing: WagerTransaction, hash: string): SubmissionReceipt {
  if (!existing.matchesPayload(hash)) throw new DomainError('IDEMPOTENCY_CONFLICT');
  return existing.getReceipt(true);
}
export class SubmitWagerTransaction {
  constructor(
    private readonly store: WageringStore,
    private readonly knownProviders: ReadonlySet<string>,
    private readonly policy: ReferenceRetryPolicy,
  ) {}
  async execute(
    input: WagerCommand,
    key: string,
    context: EventContext,
    execution: SubmissionExecution = {},
  ): Promise<SubmissionReceipt> {
    if (!this.knownProviders.has(input.providerId)) throw new DomainError('UNKNOWN_PROVIDER');
    const payload = WagerPayload.create(input);
    const command = payload.command;
    return this.store.transaction(async (session) => {
      if (execution.inbox) {
        const { consumerName, messageId } = execution.inbox;
        const hash = createHash('sha256')
          .update(JSON.stringify([payload.hash, key]))
          .digest('hex');
        await session.claimInbox(consumerName, messageId, hash);
      }
      const submit = async (): Promise<SubmissionReceipt> => {
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
      };
      const receipt = await submit();
      if (execution.inbox)
        await session.completeInbox(
          execution.inbox.consumerName,
          execution.inbox.messageId,
          receipt.body.transactionId,
        );
      return receipt;
    }, execution.signal);
  }
}
