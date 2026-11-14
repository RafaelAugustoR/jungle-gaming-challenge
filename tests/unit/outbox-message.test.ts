import { expect, test } from 'bun:test';
import { OutboxMessage } from '../../src/messaging/domain/outbox-message';
import { WagerTransactionProcessed } from '../../src/modules/wagering/domain/events/wager-events';
import { Money } from '../../src/shared/domain/money';

const occurredAt = '2026-11-14T10:00:00.000Z';
const options = { retryBaseMs: 1000, retryMaxMs: 60000 };
const walletId = crypto.randomUUID();
function event() {
  return WagerTransactionProcessed.from(
    {
      providerId: 'provider-a',
      externalTransactionId: 'bet-1',
      walletId,
      playerId: 'player',
      roundId: 'round',
      gameId: 'game',
      kind: 'BET',
      money: Money.create('1.00', 'BRL'),
    },
    crypto.randomUUID(),
    { amount: '9.00', currency: 'BRL' },
    occurredAt,
    { correlationId: 'correlation' },
  );
}
function state(overrides: Partial<Parameters<typeof OutboxMessage.rehydrate>[0]> = {}) {
  return {
    eventId: crypto.randomUUID(),
    aggregateId: walletId,
    eventType: 'WagerTransactionProcessed',
    payload: {},
    occurredAt,
    attempts: 1,
    nextAttemptAt: occurredAt,
    ...overrides,
  };
}

test('enqueue captures the event envelope as a pending, immediately due message', () => {
  const source = event();
  const message = OutboxMessage.enqueue(source);
  expect(message.id).toBe(source.eventId);
  expect(message.eventId).toBe(source.eventId);
  expect(message.aggregateId).toBe(walletId);
  expect(message.eventType).toBe('WagerTransactionProcessed');
  expect(message.payload).toEqual(source.toJSON());
  expect(message.occurredAt).toBe(occurredAt);
  expect(message.attempts).toBe(0);
  expect(message.nextAttemptAt).toBe(occurredAt);
  expect(message.publishedAt).toBeUndefined();
  expect(message.isPending()).toBe(true);
  expect(message.isDue(occurredAt)).toBe(true);
});

test('a message is due only while pending and once its next attempt has arrived', () => {
  const message = OutboxMessage.rehydrate(state({ nextAttemptAt: '2026-11-14T10:00:05.000Z' }));
  expect(message.isDue('2026-11-14T10:00:04.999Z')).toBe(false);
  expect(message.isDue('2026-11-14T10:00:05.000Z')).toBe(true);
  message.markPublished('2026-11-14T10:00:06.000Z');
  expect(message.isDue('2026-11-14T10:00:07.000Z')).toBe(false);
});

test('a published message cannot be published again or rescheduled', () => {
  const message = OutboxMessage.enqueue(event());
  message.markPublished('2026-11-14T10:00:01.000Z');
  expect(message.isPending()).toBe(false);
  expect(message.publishedAt).toBe('2026-11-14T10:00:01.000Z');
  expect(() => message.markPublished('2026-11-14T10:00:02.000Z')).toThrow(
    'INVALID_MESSAGE_TRANSITION',
  );
  expect(() => message.scheduleRetry('2026-11-14T10:00:02.000Z', options)).toThrow(
    'INVALID_MESSAGE_TRANSITION',
  );
  expect(message.publishedAt).toBe('2026-11-14T10:00:01.000Z');
});

test('retries back off exponentially with bounded jitter from the leased attempt count', () => {
  const now = '2026-11-14T10:01:00.000Z';
  const first = OutboxMessage.rehydrate(state({ attempts: 1 }));
  expect(first.scheduleRetry(now, options, 0)).toBe(500);
  expect(first.nextAttemptAt).toBe('2026-11-14T10:01:00.500Z');
  expect(first.attempts).toBe(1);
  expect(first.isDue('2026-11-14T10:01:00.499Z')).toBe(false);
  expect(OutboxMessage.rehydrate(state({ attempts: 1 })).scheduleRetry(now, options, 1)).toBe(1000);
  expect(OutboxMessage.rehydrate(state({ attempts: 3 })).scheduleRetry(now, options, 0)).toBe(2000);
  for (const random of [0, 0.3, 1]) {
    const delay = OutboxMessage.rehydrate(state({ attempts: 100 })).scheduleRetry(
      now,
      options,
      random,
    );
    expect(delay).toBeGreaterThanOrEqual(30000);
    expect(delay).toBeLessThanOrEqual(60000);
  }
});

test('rehydrate restores persisted state without revalidating it', () => {
  const published = OutboxMessage.rehydrate(
    state({ attempts: 7, eventType: '', publishedAt: '2026-11-14T10:00:01.000Z' }),
  );
  expect(published.eventType).toBe('');
  expect(published.attempts).toBe(7);
  expect(published.isPending()).toBe(false);
  expect(() => published.markPublished(occurredAt)).toThrow('INVALID_MESSAGE_TRANSITION');
});
