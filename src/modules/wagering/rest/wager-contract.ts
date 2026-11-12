import { DomainError } from '../../../shared/domain/errors/domain-error';
import { Money } from '../../../shared/domain/money';
import type { BetCommand } from '../domain/wager-transaction';
import { parseWalletId } from '../../wallets/rest/wallet-contract';
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128)
    throw new DomainError('INVALID_PAYLOAD');
  return value;
}
export function parseBet(body: unknown): BetCommand {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new DomainError('INVALID_PAYLOAD');
  const input = body as Record<string, unknown>;
  const keys = [
    'providerId',
    'externalTransactionId',
    'playerId',
    'walletId',
    'roundId',
    'gameId',
    'kind',
    'money',
  ];
  if (Object.keys(input).some((key) => !keys.includes(key)) || input.kind !== 'BET')
    throw new DomainError('INVALID_PAYLOAD');
  if (!input.money || typeof input.money !== 'object' || Array.isArray(input.money))
    throw new DomainError('INVALID_PAYLOAD');
  const money = input.money as Record<string, unknown>;
  if (
    Object.keys(money).some((key) => !['amount', 'currency'].includes(key)) ||
    typeof money.amount !== 'string' ||
    typeof money.currency !== 'string'
  )
    throw new DomainError('INVALID_PAYLOAD');
  return {
    providerId: identifier(input.providerId),
    externalTransactionId: identifier(input.externalTransactionId),
    playerId: identifier(input.playerId),
    walletId: parseWalletId(identifier(input.walletId)).toLowerCase(),
    roundId: identifier(input.roundId),
    gameId: identifier(input.gameId),
    kind: 'BET',
    money: Money.create(money.amount, money.currency),
  };
}
