export type Outcome =
  | 'processed'
  | 'rejected'
  | 'replay'
  | 'pending'
  | 'conflict'
  | 'error'
  | 'not_issued';

/**
 * Business outcomes (processed, rejected, replay) are kept apart from technical errors:
 * a 422 rejection is the system working, while 5xx, auth failures and transport errors are not.
 */
export function classifyResponse(status: number, body: unknown): Outcome {
  if (!body || typeof body !== 'object') return 'error';
  const value = body as { idempotentReplay?: unknown; status?: unknown; failureCode?: unknown };
  if ((status === 200 || status === 422) && value.idempotentReplay === true) return 'replay';
  if (status === 200 && value.status === 'PROCESSED') return 'processed';
  if (status === 422 && typeof value.failureCode === 'string') return 'rejected';
  if (status === 202) return 'pending';
  if (status === 409) return 'conflict';
  return 'error';
}
