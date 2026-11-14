import type { SendResult } from './generator';
import type { PlannedOperation } from './plan';

export const PROVIDER_ID = 'provider-a';
export interface Wallet {
  id: string;
  playerId: string;
}
export const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

/**
 * HTTP adapter for the submission contract. Business outcomes (processed, rejected, replay) stay
 * apart from technical errors: a 422 rejection is the system working, while 5xx, auth failures
 * and transport errors are not.
 */
export function classifySubmission(status: number, body: unknown): SendResult {
  const value = (body && typeof body === 'object' ? body : {}) as {
    idempotentReplay?: unknown;
    status?: unknown;
    failureCode?: unknown;
    code?: unknown;
  };
  const code =
    typeof value.failureCode === 'string'
      ? value.failureCode
      : typeof value.code === 'string'
        ? value.code
        : undefined;
  const meta = { httpStatus: status, ...(code ? { code } : {}) };
  if (!body || typeof body !== 'object') return { outcome: 'error', ...meta };
  const replay = value.idempotentReplay === true;
  if (status === 200 && value.status === 'PROCESSED')
    return { outcome: 'definitive', state: 'PROCESSED', replay, ...meta };
  if (status === 422 && typeof value.failureCode === 'string')
    return { outcome: 'definitive', state: 'REJECTED', replay, ...meta };
  if (status === 202) return { outcome: 'pending', ...meta };
  if (status === 409) return { outcome: 'conflict', ...meta };
  return { outcome: 'error', ...meta };
}

export async function submitWager(
  base: string,
  token: string,
  op: PlannedOperation,
  wallet: Wallet,
  timeoutMs: number,
): Promise<SendResult> {
  const response = await fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Idempotency-Key': op.idempotencyKey },
    body: JSON.stringify({
      providerId: PROVIDER_ID,
      externalTransactionId: op.externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: op.roundId,
      gameId: 'load-game',
      kind: op.kind,
      money: { amount: op.amount, currency: 'BRL' },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return classifySubmission(response.status, await response.json().catch(() => null));
}
