import { SendMessageCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { publicationFailure, retryDelay, MessageTooLarge } from './publication-policy';
import { WorkerBackoff } from '../worker-backoff';
import { OutboxRepository, outboxLogContext, type ReservedEvent } from './outbox-repository';
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
  retryScheduled?(disposition: 'blocked' | 'retryable'): void;
}
export class OutboxPublisher {
  private outageAttempts = 0;
  private readonly logger = new JsonLogger();
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
    if (results.some((result) => result.status === 'fulfilled' && result.value)) {
      this.outageAttempts++;
      throw new WorkerBackoff(retryDelay(this.outageAttempts, this.options));
    }
    if (events.length) this.outageAttempts = 0;
    return events.length;
  }
  private async publish(event: ReservedEvent): Promise<boolean> {
    const logContext = outboxLogContext(event);
    await this.observer.reserved?.(event);
    const body = JSON.stringify({ ...event.payload, sequence: event.sequence });
    try {
      const sent = await this.sqs.send(
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
        this.logger.warn({
          event: 'outbox_confirmation_stale',
          ...logContext,
          messageId: sent.MessageId ?? event.eventId,
        });
      else
        this.logger.log({
          event: 'outbox_published',
          ...logContext,
          messageId: sent.MessageId ?? event.eventId,
        });
    } catch (error) {
      let failure = error;
      if (error instanceof Error && error.name === 'InvalidParameterValue') {
        try {
          const { Attributes } = await this.sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: this.options.queueUrl,
              AttributeNames: ['MaximumMessageSize'],
            }),
            { abortSignal: AbortSignal.timeout(this.options.sendTimeoutMs) },
          );
          const maximum = Number(Attributes?.MaximumMessageSize);
          if (
            Number.isInteger(maximum) &&
            maximum >= 1024 &&
            maximum <= 1048576 &&
            Buffer.byteLength(body, 'utf8') > maximum
          )
            failure = new MessageTooLarge();
        } catch {
          /* Ambiguous diagnosis remains retryable; never block on configuration failure. */
        }
      }
      const { code, blocked, delayMs, pauseWorker } = publicationFailure(
        failure,
        event.attempts,
        this.options,
      );
      this.observer.retryScheduled?.(blocked ? 'blocked' : 'retryable');
      await this.repository.fail(event.eventId, event.token, code, delayMs, blocked);
      this.logger.warn({
        event: blocked ? 'outbox_blocked' : 'outbox_retry',
        ...logContext,
        messageId: event.eventId,
        code,
        attempt: event.attempts,
      });
      return pauseWorker;
    }
    return false;
  }
}
