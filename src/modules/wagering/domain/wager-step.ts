import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { EventContext } from '../../../shared/domain/events/integration-event';
import type { Money } from '../../../shared/domain/money';
import type { Wallet } from '../../wallets/domain/wallet';
import type { WagerCommand, WagerKind } from './wager-command';
import type { WagerTransaction, TransactionStatus, WagerOutcome } from './wager-transaction';
import type { WagerFailureCode } from './submission-receipt';
export interface WagerReference {
  id: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  currency: string;
  roundId: string;
  kind: WagerKind;
  status: TransactionStatus;
  money: Money;
  reversedBy: ReadonlySet<WagerKind>;
}
type ResolvedReference = WagerReference & { status: 'PROCESSED' };
interface Resources {
  counterpartAccountId: string;
  occurredAt: string;
}
type Movement = (
  transaction: WagerTransaction,
  wallet: Wallet,
  resources: Resources,
  context: EventContext,
) => WagerOutcome;
type ReferencedMovement = (
  transaction: WagerTransaction,
  wallet: Wallet,
  resources: Resources,
  context: EventContext,
  reference: ResolvedReference,
) => WagerOutcome;
interface WagerStep {
  validate(command: WagerCommand): void;
  apply(
    transaction: WagerTransaction,
    wallet: Wallet,
    resources: Resources,
    context: EventContext,
    reference?: WagerReference,
  ): WagerOutcome;
}
interface ReferencePolicy {
  allowedKinds: readonly WagerKind[];
  reversal?: boolean;
}
function rejected(
  wallet: Wallet,
  failureCode: WagerFailureCode,
  referenceTransactionId?: string,
): WagerOutcome {
  return { status: 'REJECTED', wallet, failureCode, referenceTransactionId };
}
function validateReference(command: WagerCommand): void {
  // Structural validation belongs to WagerPayload so HTTP and queue callers share it.
  if (command.referenceExternalTransactionId === command.externalTransactionId)
    throw new DomainError('INVALID_PAYLOAD');
}
function resolveReference(
  policy: ReferencePolicy,
  transaction: WagerTransaction,
  wallet: Wallet,
  reference?: WagerReference,
): ResolvedReference | WagerOutcome {
  if (!reference) return { status: 'PENDING_REFERENCE', wallet };
  const reject = (code: WagerFailureCode) => rejected(wallet, code, reference.id);
  const { command } = transaction;
  // Store resolves by (providerId, externalTransactionId); identity is scoped there.
  if (
    reference.playerId !== command.playerId ||
    reference.walletId !== command.walletId ||
    reference.currency !== command.money.currency ||
    reference.roundId !== command.roundId
  )
    return reject('REFERENCE_CONTEXT_MISMATCH');
  if (!policy.allowedKinds.includes(reference.kind)) return reject('REFERENCE_KIND_MISMATCH');
  if (policy.reversal && !reference.money.subtract(transaction.money).isZero())
    return reject('REFERENCE_AMOUNT_MISMATCH');
  if (reference.status === 'REJECTED' || reference.status === 'FAILED')
    return reject('REFERENCE_NOT_PROCESSED');
  if (reference.status !== 'PROCESSED') return { status: 'PENDING_REFERENCE', wallet };
  if (policy.reversal && reference.reversedBy.has(transaction.kind))
    return reject('ALREADY_REVERSED');
  return { ...reference, status: 'PROCESSED' };
}
function attachReference(outcome: WagerOutcome, reference: ResolvedReference): WagerOutcome {
  return outcome.status === 'PENDING_REFERENCE'
    ? outcome
    : { ...outcome, referenceTransactionId: reference.id };
}
function optionalReferenceStep(movement: Movement): WagerStep {
  return {
    validate: validateReference,
    apply(transaction, wallet, resources, context, reference) {
      if (!transaction.command.referenceExternalTransactionId)
        return movement(transaction, wallet, resources, context);
      const resolution = resolveReference(
        { allowedKinds: ['BET'] },
        transaction,
        wallet,
        reference,
      );
      if ('wallet' in resolution) return resolution;
      return attachReference(movement(transaction, wallet, resources, context), resolution);
    },
  };
}
function reversalStep(allowedKinds: readonly WagerKind[], movement: ReferencedMovement): WagerStep {
  return {
    validate: validateReference,
    apply(transaction, wallet, resources, context, reference) {
      if (!transaction.command.referenceExternalTransactionId)
        return rejected(wallet, 'REFERENCE_REQUIRED');
      const resolution = resolveReference(
        { allowedKinds, reversal: true },
        transaction,
        wallet,
        reference,
      );
      if ('wallet' in resolution) return resolution;
      return attachReference(
        movement(transaction, wallet, resources, context, resolution),
        resolution,
      );
    },
  };
}
function moveWallet(
  direction: 'debit' | 'credit',
  insufficientFundsCode:
    | 'INSUFFICIENT_FUNDS'
    | 'REVERSAL_INSUFFICIENT_FUNDS' = 'INSUFFICIENT_FUNDS',
): Movement {
  return (transaction, wallet, resources, context) => {
    const result = wallet[direction]({
      transactionId: transaction.id,
      money: transaction.money,
      ...resources,
      context,
    });
    return result.status === 'REJECTED' && result.failureCode === 'INSUFFICIENT_FUNDS'
      ? rejected(wallet, insufficientFundsCode)
      : result;
  };
}
const rollbackDebit = moveWallet('debit', 'REVERSAL_INSUFFICIENT_FUNDS');
const rollbackCredit = moveWallet('credit');
const steps: Record<WagerKind, WagerStep> = {
  BET: {
    validate(command) {
      if (command.referenceExternalTransactionId !== undefined)
        throw new DomainError('INVALID_PAYLOAD');
    },
    apply: moveWallet('debit'),
  },
  WIN: optionalReferenceStep(moveWallet('credit')),
  LOSS: optionalReferenceStep((_transaction, wallet) => ({ status: 'PROCESSED', wallet })),
  REFUND: reversalStep(['BET'], moveWallet('credit')),
  ROLLBACK: reversalStep(
    ['BET', 'WIN', 'REFUND'],
    (transaction, wallet, resources, context, reference) => {
      const movement = reference.kind === 'BET' ? rollbackCredit : rollbackDebit;
      return movement(transaction, wallet, resources, context);
    },
  ),
};
export function wagerStepFor(kind: WagerKind): WagerStep {
  if (!Object.hasOwn(steps, kind)) throw new DomainError('INVALID_PAYLOAD');
  return steps[kind];
}
