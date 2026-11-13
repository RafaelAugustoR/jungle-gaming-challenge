import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { EventContext } from '../../../shared/domain/events/integration-event';
import { WagerTransaction } from '../domain/wager-transaction';
import type { WagerCommand } from '../domain/wager-command';
import { WagerPayload } from '../domain/wager-payload';
import { wagerStepFor } from '../domain/wager-step';
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
  ) {}
  async execute(
    input: WagerCommand,
    key: string,
    context: EventContext,
  ): Promise<SubmissionReceipt> {
    if (!this.knownProviders.has(input.providerId)) throw new DomainError('UNKNOWN_PROVIDER');
    const payload = WagerPayload.create(input);
    const command = payload.command;
    const step = wagerStepFor(command.kind);
    return this.store.transaction(async (session) => {
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
      const resources = await session.resources(wallet.currency);
      const reference = command.referenceExternalTransactionId
        ? await session.findReference(command.providerId, command.referenceExternalTransactionId)
        : undefined;
      const transaction = WagerTransaction.create({
        payload,
        idempotencyKey: key,
        createdAt: resources.occurredAt,
      });
      const outcome = step.apply(transaction, wallet, resources, context, reference);
      transaction.complete(outcome, resources.occurredAt, context);
      await session.save({ transaction, wallet: outcome.wallet, change: outcome.change });
      return transaction.getReceipt();
    });
  }
}
