import { DomainError } from '../../../shared/domain/errors/domain-error';
import { Money } from '../../../shared/domain/money';
import type { CreateWalletCommand, LedgerQuery } from '../application/wallet-store';
import type { Wallet } from '../domain/wallet';

export function parseCreateWallet(body: unknown): CreateWalletCommand {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new DomainError('INVALID_PAYLOAD');
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !['playerId', 'initialBalance'].includes(key)) ||
    typeof input.playerId !== 'string' ||
    !input.initialBalance ||
    typeof input.initialBalance !== 'object' ||
    Array.isArray(input.initialBalance)
  )
    throw new DomainError('INVALID_PAYLOAD');
  const initial = input.initialBalance as Record<string, unknown>;
  if (
    Object.keys(initial).some((key) => !['amount', 'currency'].includes(key)) ||
    typeof initial.amount !== 'string' ||
    initial.currency !== 'BRL'
  )
    throw new DomainError('INVALID_PAYLOAD');
  return {
    playerId: input.playerId,
    initialBalance: Money.create(initial.amount, initial.currency),
  };
}
export function parseLedgerQuery(
  walletId: string,
  cursor?: string,
  limitValue?: string,
): LedgerQuery {
  const limit = limitValue === undefined ? 50 : Number(limitValue);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (limitValue !== undefined && !/^\d+$/.test(limitValue))
  )
    throw new DomainError('INVALID_PAYLOAD');
  if (cursor === undefined) return { limit };
  try {
    const match = /^v1\.([A-Za-z0-9_-]+)$/.exec(cursor);
    if (!match || cursor.length > 256) throw new Error();
    const encoded = match[1]!;
    const decoded = Buffer.from(encoded, 'base64url').toString();
    if (Buffer.from(decoded).toString('base64url') !== encoded) throw new Error();
    const parsed = JSON.parse(decoded);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'after,upper,walletId' ||
      parsed.walletId !== walletId ||
      !Number.isSafeInteger(parsed.after) ||
      !Number.isSafeInteger(parsed.upper) ||
      parsed.after < 0 ||
      parsed.after >= parsed.upper
    )
      throw new Error();
    return { limit, cursor: { after: parsed.after, upper: parsed.upper } };
  } catch {
    throw new DomainError('INVALID_PAYLOAD');
  }
}
export function walletResponse(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toProps(),
    version: wallet.version,
  };
}
export function ledgerResponse(
  walletId: string,
  page: { entries: unknown[]; next: { after: number; upper: number } | null },
) {
  return {
    entries: page.entries,
    nextCursor: page.next
      ? `v1.${Buffer.from(JSON.stringify({ walletId, ...page.next })).toString('base64url')}`
      : null,
  };
}
