export interface RetryOptions {
  retryBaseMs: number;
  retryMaxMs: number;
}
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
/** Classifies a send failure; the retry delay belongs to OutboxMessage.scheduleRetry. */
export function publicationFailure(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  return {
    code: /^[A-Za-z0-9_]{1,100}$/.test(name) ? name : 'PublishError',
    blocked: ['InvalidMessageContents', 'MessageTooLarge'].includes(name),
    pauseWorker: [
      'AccessDeniedException',
      'InvalidClientTokenId',
      'UnrecognizedClientException',
      'QueueDoesNotExist',
      'InvalidParameterValue',
      'UnsupportedOperation',
    ].includes(name),
  };
}

export class MessageTooLarge extends Error {
  constructor() {
    super('MESSAGE_TOO_LARGE');
    this.name = 'MessageTooLarge';
  }
}
