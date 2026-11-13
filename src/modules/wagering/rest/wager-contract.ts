import { DomainError } from '../../../shared/domain/errors/domain-error';
import { Money } from '../../../shared/domain/money';
import { isWagerKind, type WagerCommand } from '../domain/wager-command';
import { parseUuid } from '../../../shared/rest/parse-uuid';
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128)
    throw new DomainError('INVALID_PAYLOAD');
  return value;
}
export function parseWagerCommand(body: unknown): WagerCommand {
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
  if (Object.keys(input).some((key) => !keys.includes(key)) || !isWagerKind(input.kind))
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
    walletId: parseUuid(identifier(input.walletId)),
    roundId: identifier(input.roundId),
    gameId: identifier(input.gameId),
    kind: input.kind,
    money: Money.create(money.amount, money.currency),
  };
}
