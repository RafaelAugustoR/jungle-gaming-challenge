import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { EventContext } from '../../../shared/domain/events/integration-event';
import type { Money } from '../../../shared/domain/money';
import type { Wallet, WalletChange } from '../../wallets/domain/wallet';
import type { WagerCommand, WagerKind } from './wager-command';
import type { WagerTransaction, TransactionStatus } from './wager-transaction';
import type { WagerFailureCode } from './submission-receipt';
export interface WagerReference {
  id: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  currency: string;
  roundId: string;
  kind: string;
  status: TransactionStatus;
  money: Money;
}
export type WagerStepResult =
  | { status: 'PROCESSED'; wallet: Wallet; change?: WalletChange }
  | { status: 'PENDING_REFERENCE'; wallet: Wallet; change?: never }
  | { status: 'REJECTED'; wallet: Wallet; failureCode: WagerFailureCode; change?: never };
interface WagerStep {
  validate(command: WagerCommand): void;
  apply(
    transaction: WagerTransaction,
    wallet: Wallet,
    resources: { counterpartAccountId: string; occurredAt: string },
    context: EventContext,
    reference?: WagerReference,
    alreadyReversed?: boolean,
  ): WagerStepResult;
}
type Movement = WagerStep['apply'];
interface ReferencePolicy {
  allowedKinds: readonly string[];
  reversal?: boolean;
}
function rejected(wallet: Wallet, failureCode: WagerFailureCode): WagerStepResult {
  return { status: 'REJECTED', wallet, failureCode };
}
function validateReferenceSyntax(command: WagerCommand): void {
  const reference = command.referenceExternalTransactionId;
  if (
    reference !== undefined &&
    (typeof reference !== 'string' ||
      !reference.trim() ||
      reference.length > 128 ||
      reference === command.externalTransactionId)
  )
    throw new DomainError('INVALID_PAYLOAD');
}
function checkReference(
  policy: ReferencePolicy,
  transaction: WagerTransaction,
  wallet: Wallet,
  reference: WagerReference | undefined,
  alreadyReversed: boolean,
): WagerStepResult | undefined {
  const { command } = transaction;
  if (!command.referenceExternalTransactionId)
    return policy.reversal ? rejected(wallet, 'REFERENCE_REQUIRED') : undefined;
  if (!reference) return { status: 'PENDING_REFERENCE', wallet };
  if (
    reference.providerId !== command.providerId ||
    reference.playerId !== command.playerId ||
    reference.walletId !== command.walletId ||
    reference.currency !== command.money.currency ||
    reference.roundId !== command.roundId
  )
    return rejected(wallet, 'REFERENCE_CONTEXT_MISMATCH');
  if (!policy.allowedKinds.includes(reference.kind))
    return rejected(wallet, 'REFERENCE_KIND_MISMATCH');
  if (policy.reversal && !reference.money.subtract(transaction.money).isZero())
    return rejected(wallet, 'REFERENCE_AMOUNT_MISMATCH');
  if (reference.status === 'REJECTED' || reference.status === 'FAILED')
    return rejected(wallet, 'REFERENCE_NOT_PROCESSED');
  if (reference.status !== 'PROCESSED') return { status: 'PENDING_REFERENCE', wallet };
  if (policy.reversal && alreadyReversed) return rejected(wallet, 'ALREADY_REVERSED');
}
function withReference(policy: ReferencePolicy, movement: Movement): WagerStep {
  return {
    validate: validateReferenceSyntax,
    apply(transaction, wallet, resources, context, reference, alreadyReversed = false) {
      return (
        checkReference(policy, transaction, wallet, reference, alreadyReversed) ??
        movement(transaction, wallet, resources, context, reference, alreadyReversed)
      );
    },
  };
}
function moveWallet(direction: 'debit' | 'credit', reversal = false): Movement {
  return (transaction, wallet, resources, context) => {
    try {
      const result = wallet[direction]({
        transactionId: transaction.id,
        money: transaction.money,
        ...resources,
        context,
      });
      return result.status === 'REJECTED' && reversal
        ? rejected(wallet, 'REVERSAL_INSUFFICIENT_FUNDS')
        : result;
    } catch (error) {
      if (error instanceof DomainError && error.code === 'AMOUNT_LIMIT_EXCEEDED')
        return rejected(wallet, 'AMOUNT_LIMIT_EXCEEDED');
      throw error;
    }
  };
}
const rollbackDebit = moveWallet('debit', true);
const rollbackCredit = moveWallet('credit', true);
const steps: Record<WagerKind, WagerStep> = {
  BET: {
    validate(command) {
      if (command.referenceExternalTransactionId !== undefined)
        throw new DomainError('INVALID_PAYLOAD');
    },
    apply: moveWallet('debit'),
  },
  WIN: withReference({ allowedKinds: ['BET'] }, moveWallet('credit')),
  LOSS: withReference({ allowedKinds: ['BET'] }, (_transaction, wallet) => ({
    status: 'PROCESSED',
    wallet,
  })),
  REFUND: withReference({ allowedKinds: ['BET'], reversal: true }, moveWallet('credit', true)),
  ROLLBACK: withReference(
    { allowedKinds: ['BET', 'WIN', 'REFUND'], reversal: true },
    (transaction, wallet, resources, context, reference) => {
      // The reference policy ensures this exists and is reversible before movement.
      const movement = reference!.kind === 'BET' ? rollbackCredit : rollbackDebit;
      return movement(transaction, wallet, resources, context);
    },
  ),
};
export function wagerStepFor(kind: WagerKind): WagerStep {
  if (!Object.hasOwn(steps, kind)) throw new DomainError('INVALID_PAYLOAD');
  return steps[kind];
}
