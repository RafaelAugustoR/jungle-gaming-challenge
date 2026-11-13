import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { publicationFailure, retryDelay } from './publication-policy';
import { WorkerBackoff } from '../worker-backoff';
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
export class OutboxPublisher {
  private outageAttempts = 0;
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
    await this.observer.reserved?.(event);
    try {
      const body = JSON.stringify({ ...event.payload, sequence: event.sequence });
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
      const { code, blocked, delayMs, pauseWorker } = publicationFailure(
        error,
        event.attempts,
        this.options,
      );
      await this.repository.fail(event.eventId, event.token, code, delayMs, blocked);
      new JsonLogger().warn({
        event: blocked ? 'outbox_blocked' : 'outbox_retry',
        eventId: event.eventId,
        aggregateId: event.aggregateId,
        code,
        attempt: event.attempts,
      });
      return pauseWorker;
    }
    return false;
  }
}
