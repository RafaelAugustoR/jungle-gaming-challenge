import type { EventContext } from '../../../shared/domain/events/integration-event';
import type { Wallet } from '../../wallets/domain/wallet';
import { wagerStepFor } from '../domain/wager-step';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { WageringSession } from './wagering-store';

// Both callers hold the wallet lock before resolving references or settling funds.
export async function settleWager(
  session: WageringSession,
  makeTransaction: (occurredAt: string) => WagerTransaction,
  wallet: Wallet,
  context: EventContext,
  deadline?: string,
) {
  const resources = await session.resources(wallet.currency);
  const transaction = makeTransaction(resources.occurredAt);
  const external = transaction.command.referenceExternalTransactionId;
  const reference = external
    ? await session.findReference(transaction.providerId, external)
    : undefined;
  const outcome = wagerStepFor(transaction.kind).apply(
    transaction,
    wallet,
    resources,
    context,
    reference,
    deadline,
  );
  return { transaction, outcome, occurredAt: resources.occurredAt };
}
