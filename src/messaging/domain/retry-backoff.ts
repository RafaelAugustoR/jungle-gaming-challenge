export interface RetryOptions {
  retryBaseMs: number;
  retryMaxMs: number;
}
/** Exponential backoff with 50–100% jitter, capped at retryMaxMs. */
export function retryDelay(
  attempts: number,
  options: RetryOptions,
  random = Math.random(),
): number {
  const maximum = Math.min(
    options.retryMaxMs,
    options.retryBaseMs * 2 ** Math.min(Math.max(attempts - 1, 0), 20),
  );
  return Math.floor(maximum * (0.5 + Math.min(1, Math.max(0, random)) / 2));
}
