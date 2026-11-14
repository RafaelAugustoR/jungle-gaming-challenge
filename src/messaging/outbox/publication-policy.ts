/** Classifies an SQS send failure; the retry delay comes from OutboxMessage.retryDelay. */
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
