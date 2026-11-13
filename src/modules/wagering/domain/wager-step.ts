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
  direction?: 'DEBIT' | 'CREDIT';
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
function apply(
  transaction: WagerTransaction,
  wallet: Wallet,
  resources: { counterpartAccountId: string; occurredAt: string },
  context: EventContext,
  reference?: WagerReference,
  alreadyReversed = false,
): WagerStepResult {
  const { kind, command } = transaction;
  const reject = (failureCode: WagerFailureCode): WagerStepResult => ({
    status: 'REJECTED',
    wallet,
    failureCode,
  });
  const reversal = kind === 'REFUND' || kind === 'ROLLBACK';
  if (reversal && !command.referenceExternalTransactionId) return reject('REFERENCE_REQUIRED');
  if (command.referenceExternalTransactionId) {
    if (!reference) return { status: 'PENDING_REFERENCE', wallet };
    if (
      reference.providerId !== command.providerId ||
      reference.playerId !== command.playerId ||
      reference.walletId !== command.walletId ||
      reference.currency !== command.money.currency ||
      reference.roundId !== command.roundId
    )
      return reject('REFERENCE_CONTEXT_MISMATCH');
    const allowed = kind === 'ROLLBACK' ? ['BET', 'WIN', 'REFUND'] : ['BET'];
    if (!allowed.includes(reference.kind)) return reject('REFERENCE_KIND_MISMATCH');
    if (reversal && !reference.money.subtract(transaction.money).isZero())
      return reject('REFERENCE_AMOUNT_MISMATCH');
    if (reference.status === 'REJECTED' || reference.status === 'FAILED')
      return reject('REFERENCE_NOT_PROCESSED');
    if (reference.status !== 'PROCESSED') return { status: 'PENDING_REFERENCE', wallet };
    if (reversal && alreadyReversed) return reject('ALREADY_REVERSED');
  }
  if (kind === 'LOSS') return { status: 'PROCESSED', wallet };
  const credit =
    kind === 'WIN' || kind === 'REFUND' || (kind === 'ROLLBACK' && reference?.kind === 'BET');
  try {
    const input = {
      transactionId: transaction.id,
      money: transaction.money,
      ...resources,
      context,
    };
    const result = credit ? wallet.credit(input) : wallet.debit(input);
    return result.status === 'REJECTED' && reversal
      ? reject('REVERSAL_INSUFFICIENT_FUNDS')
      : result;
  } catch (error) {
    if (error instanceof DomainError && error.code === 'AMOUNT_LIMIT_EXCEEDED')
      return reject('AMOUNT_LIMIT_EXCEEDED');
    throw error;
  }
}
const steps: Record<WagerKind, WagerStep> = Object.fromEntries(
  (['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const).map((kind) => [
    kind,
    {
      validate(command: WagerCommand) {
        const reference = command.referenceExternalTransactionId;
        if (
          reference !== undefined &&
          (kind === 'BET' ||
            typeof reference !== 'string' ||
            !reference.trim() ||
            reference.length > 128 ||
            reference === command.externalTransactionId)
        )
          throw new DomainError('INVALID_PAYLOAD');
      },
      apply,
    },
  ]),
) as Record<WagerKind, WagerStep>;
export function wagerStepFor(kind: WagerKind): WagerStep {
  if (!Object.hasOwn(steps, kind)) throw new DomainError('INVALID_PAYLOAD');
  return steps[kind];
}
