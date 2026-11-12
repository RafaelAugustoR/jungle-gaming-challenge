import { createHash } from 'node:crypto';
import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { EventContext } from '../../../shared/domain/events/integration-event';
import { WalletBalanceChanged } from '../../wallets/domain/events/wallet-balance-changed';
import { WagerTransaction, type BetCommand } from '../domain/wager-transaction';
import { WagerTransactionProcessed, WagerTransactionRejected } from '../domain/events/wager-events';
import type { AcceptedSubmission, SubmissionReceipt, WageringStore } from './wagering-store';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
export function betHash(command: BetCommand): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ ...command, money: command.money.toProps() })))
    .digest('hex');
}
function replay(existing: AcceptedSubmission, hash: string): SubmissionReceipt {
  if (existing.hash !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT');
  return {
    httpStatus: existing.receipt.httpStatus,
    body: { ...existing.receipt.body, idempotentReplay: true },
  };
}
export class SubmitBet {
  constructor(
    private readonly store: WageringStore,
    private readonly knownProviders: ReadonlySet<string>,
  ) {}
  async execute(
    command: BetCommand,
    key: string,
    context: EventContext,
  ): Promise<SubmissionReceipt> {
    if (!this.knownProviders.has(command.providerId)) throw new DomainError('UNKNOWN_PROVIDER');
    const hash = betHash(command);
    try {
      return await this.store.transaction(async (session) => {
        const wallet = await session.lockWallet(command.walletId);
        if (!wallet) throw new DomainError('WALLET_NOT_FOUND');
        const existing = await session.findSubmission(command.providerId, key);
        if (existing) return replay(existing, hash);
        if (await session.externalExists(command.providerId, command.externalTransactionId))
          throw new DomainError('EXTERNAL_TRANSACTION_CONFLICT');
        if (wallet.playerId !== command.playerId) throw new DomainError('PLAYER_MISMATCH');
        if (wallet.currency !== command.money.currency) throw new DomainError('CURRENCY_MISMATCH');
        const transaction = WagerTransaction.create();
        const { counterpartAccountId, occurredAt } = await session.resources(wallet.currency);
        let failureCode: string | undefined;
        let movement: ReturnType<typeof wallet.debit> = { wallet };
        {
          try {
            movement = wallet.debit({
              transactionId: transaction.id,
              money: command.money,
              counterpartAccountId,
            });
          } catch (error) {
            if (!(error instanceof DomainError) || error.code !== 'INSUFFICIENT_FUNDS') throw error;
            failureCode = error.code;
          }
        }
        transaction.transition(failureCode ? 'REJECTED' : 'PROCESSED', failureCode);
        const balance = movement.wallet.balance.toProps();
        const receipt: SubmissionReceipt = {
          httpStatus: failureCode ? 422 : 200,
          body: {
            transactionId: transaction.id,
            status: failureCode ? 'REJECTED' : 'PROCESSED',
            balance,
            idempotentReplay: false,
            ...(failureCode
              ? {
                  failureCode,
                  code: failureCode,
                  message: failureCode,
                  correlationId: context.correlationId,
                }
              : {}),
          },
        };
        const balanceEvent = movement.entry
          ? WalletBalanceChanged.from(movement.entry, occurredAt, context)
          : undefined;
        const resultEvent = failureCode
          ? WagerTransactionRejected.from(
              command,
              transaction.id,
              balance,
              failureCode,
              occurredAt,
              context,
            )
          : WagerTransactionProcessed.from(command, transaction.id, balance, occurredAt, context);
        await session.save({
          command,
          key,
          hash,
          transaction,
          wallet: movement.wallet,
          receipt,
          occurredAt,
          entry: movement.entry,
          balanceEvent,
          resultEvent,
        });
        return receipt;
      });
    } catch (error) {
      // UNIQUE races across different wallets are resolved only after rollback.
      if (!(error instanceof DomainError) || error.code !== 'SUBMISSION_RACE') throw error;
      const existing = await this.store.findSubmission(command.providerId, key);
      if (existing) return replay(existing, hash);
      if (await this.store.externalExists(command.providerId, command.externalTransactionId))
        throw new DomainError('EXTERNAL_TRANSACTION_CONFLICT');
      throw new DomainError('INFRASTRUCTURE_UNAVAILABLE');
    }
  }
}
