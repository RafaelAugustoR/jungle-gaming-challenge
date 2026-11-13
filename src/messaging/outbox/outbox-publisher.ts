import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { InvalidIntegrationEvent, parseIntegrationEvent } from '../events/integration-envelope';
import { OutboxRepository, type ReservedEvent } from './outbox-repository';
import { JsonLogger } from '../../observability/logger';

export interface PublisherOptions {
  queueUrl: string;
  leaseMs: number;
  sendTimeoutMs: number;
  batchSize: number;
  retryBaseMs: number;
  retryMaxMs: number;
}
export interface PublisherObserver {
  reserved?(event: ReservedEvent): Promise<void>;
  sent?(event: ReservedEvent): Promise<void>;
}
function errorCode(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_]{1,100}$/.test(error.name)
    ? error.name
    : 'PublishError';
}
function permanent(error: unknown): boolean {
  return (
    error instanceof InvalidIntegrationEvent ||
    (error instanceof Error &&
      [
        'InvalidMessageContents',
        'InvalidParameterValue',
        'UnsupportedOperation',
        'AccessDeniedException',
        'InvalidClientTokenId',
        'UnrecognizedClientException',
      ].includes(error.name))
  );
}
export class OutboxPublisher {
  constructor(
    private readonly repository: OutboxRepository,
    private readonly sqs: SQSClient,
    private readonly options: PublisherOptions,
    private readonly observer: PublisherObserver = {},
  ) {
    if (options.sendTimeoutMs >= options.leaseMs || options.sendTimeoutMs < 1)
      throw new Error('Send timeout must be less than lease');
  }
  async runOnce(): Promise<number> {
    const events = await this.repository.claim(this.options.batchSize, this.options.leaseMs);
    const results = await Promise.allSettled(events.map((event) => this.publish(event)));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'OUTBOX_BATCH_FAILED',
      );
    return events.length;
  }
  private async publish(event: ReservedEvent): Promise<void> {
    await this.observer.reserved?.(event);
    try {
      const body = JSON.stringify({ ...event.payload, sequence: event.sequence });
      const envelope = parseIntegrationEvent(body);
      if (envelope.eventId !== event.eventId || envelope.aggregateId !== event.aggregateId)
        throw new InvalidIntegrationEvent();
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.options.queueUrl,
          MessageBody: body,
          MessageGroupId: event.aggregateId,
          MessageDeduplicationId: event.eventId,
        }),
        { abortSignal: AbortSignal.timeout(this.options.sendTimeoutMs) },
      );
      await this.observer.sent?.(event);
      const confirmed = await this.repository.confirm(event.eventId, event.token);
      if (!confirmed)
        new JsonLogger().warn({
          event: 'outbox_confirmation_stale',
          eventId: event.eventId,
          aggregateId: event.aggregateId,
        });
    } catch (error) {
      const code = errorCode(error),
        blocked = permanent(error);
      const maximum = Math.min(
        this.options.retryMaxMs,
        this.options.retryBaseMs * 2 ** Math.min(event.attempts - 1, 20),
      );
      const delay = Math.floor(maximum * (0.5 + Math.random() / 2));
      await this.repository.fail(event.eventId, event.token, code, delay, blocked);
      new JsonLogger().warn({
        event: blocked ? 'outbox_blocked' : 'outbox_retry',
        eventId: event.eventId,
        aggregateId: event.aggregateId,
        code,
        attempt: event.attempts,
      });
    }
  }
}
