import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { EventContext } from '../../../shared/domain/events/integration-event';
import type { Wallet, WalletMovementResult } from '../../wallets/domain/wallet';
import type { WagerCommand, WagerKind } from './wager-command';
import type { WagerTransaction } from './wager-transaction';
interface WagerStep {
  validate(command: WagerCommand): void;
  apply(
    transaction: WagerTransaction,
    wallet: Wallet,
    resources: { counterpartAccountId: string; occurredAt: string },
    context: EventContext,
  ): WalletMovementResult;
}
const steps: Partial<Record<WagerKind, WagerStep>> = {
  BET: {
    validate(command) {
      if (command.referenceExternalTransactionId !== undefined)
        throw new DomainError('INVALID_PAYLOAD');
    },
    apply(transaction, wallet, resources, context) {
      return wallet.debit({
        transactionId: transaction.id,
        money: transaction.money,
        ...resources,
        context,
      });
    },
  },
};
export function wagerStepFor(kind: WagerKind): WagerStep {
  const step = Object.hasOwn(steps, kind) ? steps[kind] : undefined;
  if (!step) throw new DomainError('INVALID_PAYLOAD');
  return step;
}
