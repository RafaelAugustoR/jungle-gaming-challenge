import { DomainError } from '../../shared/domain/errors/domain-error';
import type { IntegrationEvent } from '../../shared/domain/events/integration-event';
import { retryDelay, type RetryOptions } from '../outbox/publication-policy';

export interface OutboxMessageState {
  eventId: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: string;
  attempts: number;
  nextAttemptAt: string;
  publishedAt?: string;
}

/**
 * An integration event awaiting publication. `attempts` counts started publication attempts:
 * the relay increments it when it leases the message, so a failed attempt reschedules without
 * counting again. Leases, blocking and per-aggregate ordering stay in the relay's SQL.
 */
export class OutboxMessage {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
  private state: { attempts: number; nextAttemptAt: string; publishedAt?: string };
  private constructor(state: OutboxMessageState) {
    this.eventId = state.eventId;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.payload = state.payload;
    this.occurredAt = state.occurredAt;
    this.state = {
      attempts: state.attempts,
      nextAttemptAt: state.nextAttemptAt,
      ...(state.publishedAt ? { publishedAt: state.publishedAt } : {}),
    };
  }
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = event.toJSON();
    return new OutboxMessage({
      eventId: payload.eventId,
      aggregateId: payload.aggregateId,
      eventType: payload.eventType,
      payload,
      occurredAt: payload.occurredAt,
      attempts: 0,
      nextAttemptAt: payload.occurredAt,
    });
  }
  /** Restores persisted state as-is; persistence already enforced the invariants. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }
  get id(): string {
    return this.eventId;
  }
  get attempts(): number {
    return this.state.attempts;
  }
  get nextAttemptAt(): string {
    return this.state.nextAttemptAt;
  }
  get publishedAt(): string | undefined {
    return this.state.publishedAt;
  }
  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }
  isDue(now: string): boolean {
    return this.isPending() && Date.parse(this.state.nextAttemptAt) <= Date.parse(now);
  }
  markPublished(at: string): void {
    if (!this.isPending()) throw new DomainError('INVALID_MESSAGE_TRANSITION');
    this.state = { ...this.state, publishedAt: at };
  }
  /**
   * Defers the next attempt with exponential backoff and jitter. Returns the delay so the relay
   * can apply it against the database clock.
   */
  scheduleRetry(now: string, options: RetryOptions, random = Math.random()): number {
    if (!this.isPending()) throw new DomainError('INVALID_MESSAGE_TRANSITION');
    const delayMs = retryDelay(this.state.attempts, options, random);
    this.state = {
      ...this.state,
      nextAttemptAt: new Date(Date.parse(now) + delayMs).toISOString(),
    };
    return delayMs;
  }
}
