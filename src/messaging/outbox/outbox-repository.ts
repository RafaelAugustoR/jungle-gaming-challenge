import type { MikroORM } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../domain/outbox-message';
export interface ReservedEvent {
  message: OutboxMessage;
  eventId: string;
  aggregateId: string;
  transactionId: string;
  correlationId?: string;
  providerId?: string;
  sequence: number;
  payload: Record<string, unknown>;
  token: string;
  attempts: number;
}
export function outboxLogContext(event: ReservedEvent) {
  return {
    eventId: event.eventId,
    aggregateId: event.aggregateId,
    transactionId: event.transactionId,
    correlationId: event.correlationId,
    providerId: event.providerId,
  };
}
interface OutboxRow {
  event_id: string;
  aggregate_id: string;
  transaction_id: string;
  sequence: number;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  lease_token: string;
  attempts: number;
  next_attempt_at: Date;
}
/**
 * Publishable heads: the oldest unpublished event of each aggregate (per-aggregate order,
 * ADR 0013). The NOT EXISTS probe must stay proportional to unpublished events, never to the
 * aggregate's published history; see the partial index outbox_unpublished_by_aggregate.
 */
export const PUBLISHABLE_HEADS = `
          select o.event_id from wagering.outbox o
          where o.published_at is null and o.blocked_at is null
            and o.next_attempt_at<=clock_timestamp()
            and (o.lease_until is null or o.lease_until<=clock_timestamp())
            and not exists(select from wagering.outbox previous
              where previous.aggregate_id=o.aggregate_id and previous.sequence<o.sequence and previous.published_at is null)
          order by o.occurred_at,o.event_id for update of o skip locked limit ?`;
export class OutboxRepository {
  constructor(private readonly orm: MikroORM) {}
  async claim(limit: number, leaseMs: number): Promise<ReservedEvent[]> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(leaseMs) ||
      leaseMs < 1
    )
      throw new Error('Invalid outbox reservation');
    return this.orm.em.fork().transactional(async (em) => {
      const rows = await em.execute<OutboxRow[]>(
        `
        with heads as (${PUBLISHABLE_HEADS})
        update wagering.outbox o set lease_token=?,lease_until=clock_timestamp()+(? * interval '1 millisecond'),attempts=o.attempts+1
        from heads where o.event_id=heads.event_id returning o.*`,
        [limit, crypto.randomUUID(), leaseMs],
      );
      return rows.map((row) => {
        const context = eventLogContext(row.payload);
        return {
          message: OutboxMessage.rehydrate({
            eventId: row.event_id,
            aggregateId: row.aggregate_id,
            eventType: row.event_type,
            payload: row.payload,
            occurredAt: new Date(row.occurred_at).toISOString(),
            attempts: row.attempts,
            nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
          }),
          eventId: row.event_id,
          aggregateId: row.aggregate_id,
          transactionId: row.transaction_id,
          ...context,
          sequence: row.sequence,
          payload: row.payload,
          token: row.lease_token,
          attempts: row.attempts,
        };
      });
    });
  }
  async confirm(id: string, token: string): Promise<boolean> {
    const rows = await this.orm.em.fork().execute(
      `update wagering.outbox set published_at=clock_timestamp(),lease_token=null,lease_until=null,last_error_code=null
      where event_id=? and lease_token=? and lease_until>clock_timestamp() and published_at is null returning event_id`,
      [id, token],
    );
    return rows.length === 1;
  }
  async fail(
    id: string,
    token: string,
    code: string,
    delayMs: number,
    permanent: boolean,
  ): Promise<boolean> {
    const rows = await this.orm.em.fork().execute(
      `update wagering.outbox set lease_token=null,lease_until=null,last_error_code=?,
      next_attempt_at=clock_timestamp()+(? * interval '1 millisecond'),blocked_at=case when ? then clock_timestamp() else null end
      where event_id=? and lease_token=? and lease_until>clock_timestamp() and published_at is null returning event_id`,
      [code, delayMs, permanent, id, token],
    );
    return rows.length === 1;
  }
  async retryBlocked(id: string): Promise<boolean> {
    const rows = await this.orm.em.fork().execute(
      `update wagering.outbox set blocked_at=null,next_attempt_at=clock_timestamp(),last_error_code=null
      where event_id=? and published_at is null and blocked_at is not null and lease_token is null returning event_id`,
      [id],
    );
    return rows.length === 1;
  }
}

function eventLogContext(
  payload: Record<string, unknown>,
): Pick<ReservedEvent, 'correlationId' | 'providerId'> {
  const eventData = payload.data;
  const correlationId = payload.correlationId;
  const providerId =
    eventData && typeof eventData === 'object' && 'providerId' in eventData
      ? (eventData as { providerId?: unknown }).providerId
      : undefined;
  return {
    correlationId: typeof correlationId === 'string' ? correlationId : undefined,
    providerId: typeof providerId === 'string' ? providerId : undefined,
  };
}
