import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { EventContext } from '../../../shared/domain/events/integration-event';
import type { Wallet, WalletMovementResult } from '../../wallets/domain/wallet';
import { WagerTransaction } from '../domain/wager-transaction';
import { wagerPayloadHash, type WagerCommand, type WagerKind } from '../domain/wager-command';
import type { SubmissionReceipt } from '../domain/submission-receipt';
import type { WageringStore } from './wagering-store';

type WagerStep = (
  transaction: WagerTransaction,
  wallet: Wallet,
  resources: { counterpartAccountId: string; occurredAt: string },
  context: EventContext,
) => WalletMovementResult;
// Each kind supplies its financial step; the transaction/idempotency path is shared.
const steps: Partial<Record<WagerKind, WagerStep>> = {
  BET: (transaction, wallet, resources, context) =>
    wallet.debit({
      transactionId: transaction.id,
      money: transaction.money,
      ...resources,
      context,
    }),
};
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
    command: WagerCommand,
    key: string,
    context: EventContext,
  ): Promise<SubmissionReceipt> {
    if (!this.knownProviders.has(command.providerId)) throw new DomainError('UNKNOWN_PROVIDER');
    const step = steps[command.kind];
    if (!step) throw new DomainError('INVALID_PAYLOAD');
    const hash = wagerPayloadHash(command);
    return this.store.transaction(async (session) => {
      // Read-only preflight makes an accepted key authoritative even for a changed wallet.
      const accepted = await session.findSubmission(command.providerId, key);
      if (accepted) return replay(accepted, hash);
      const wallet = await session.lockWallet(command.walletId);
      if (!wallet) throw new DomainError('WALLET_NOT_FOUND');
      // Recheck after locking: another process may have committed while we waited.
      const existing = await session.findSubmission(command.providerId, key);
      if (existing) return replay(existing, hash);
      if (await session.externalExists(command.providerId, command.externalTransactionId))
        throw new DomainError('EXTERNAL_TRANSACTION_CONFLICT');
      if (wallet.playerId !== command.playerId) throw new DomainError('PLAYER_MISMATCH');
      if (wallet.currency !== command.money.currency) throw new DomainError('CURRENCY_MISMATCH');
      const resources = await session.resources(wallet.currency);
      const transaction = WagerTransaction.create({
        command,
        idempotencyKey: key,
        createdAt: resources.occurredAt,
      });
      const outcome = step(transaction, wallet, resources, context);
      transaction.complete(outcome, resources.occurredAt, context);
      await session.save({ transaction, wallet: outcome.wallet, change: outcome.change });
      return transaction.getReceipt();
    });
  }
}
