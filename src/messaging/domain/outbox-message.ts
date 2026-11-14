import type { IntegrationEvent } from '../../shared/domain/events/integration-event';
import { retryDelay, type RetryOptions } from './retry-backoff';

export interface OutboxMessageState {
  eventId: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: string;
  attempts: number;
}

/**
 * An integration event persisted for publication: identity, the serialized envelope and the
 * number of started publication attempts. Reservation, leases, publication and the due clock
 * are owned by the outbox SQL (database clock, lease token), so they are not mirrored here.
 */
export class OutboxMessage {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
  readonly attempts: number;
  private constructor(state: OutboxMessageState) {
    this.eventId = state.eventId;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.payload = state.payload;
    this.occurredAt = state.occurredAt;
    this.attempts = state.attempts;
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
    });
  }
  /** Restores persisted state as-is; persistence already enforced the invariants. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }
  /**
   * Delay before the next attempt. `attempts` already counts the current one (the claim
   * increments it), so a failed attempt is not counted twice.
   */
  retryDelay(options: RetryOptions, random = Math.random()): number {
    return retryDelay(this.attempts, options, random);
  }
}
