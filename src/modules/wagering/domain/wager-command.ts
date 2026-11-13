import { createHash } from 'node:crypto';
import type { Money } from '../../../shared/domain/money';
export const wagerKinds = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type WagerKind = (typeof wagerKinds)[number];
export const transactionKinds = ['OPENING', ...wagerKinds] as const;
export type TransactionKind = (typeof transactionKinds)[number];
export function isWagerKind(value: unknown): value is WagerKind {
  return typeof value === 'string' && wagerKinds.includes(value as WagerKind);
}
export function isTransactionKind(value: unknown): value is TransactionKind {
  return typeof value === 'string' && transactionKinds.includes(value as TransactionKind);
}
export interface WagerCommand {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: Money;
  referenceExternalTransactionId?: string;
}
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
export function wagerPayloadHash(command: WagerCommand): string {
  const {
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    kind,
    referenceExternalTransactionId,
  } = command;
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          providerId,
          externalTransactionId,
          playerId,
          walletId,
          roundId,
          gameId,
          kind,
          money: command.money.toProps(),
          ...(referenceExternalTransactionId === undefined
            ? {}
            : { referenceExternalTransactionId }),
        }),
      ),
    )
    .digest('hex');
}
