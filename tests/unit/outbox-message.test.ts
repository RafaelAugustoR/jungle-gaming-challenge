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
    ...overrides,
  };
}

test('enqueue captures the serialized event envelope with no attempts yet', () => {
  const source = event();
  const message = OutboxMessage.enqueue(source);
  expect(message.eventId).toBe(source.toJSON().eventId);
  expect(message.aggregateId).toBe(walletId);
  expect(message.eventType).toBe('WagerTransactionProcessed');
  expect(message.occurredAt).toBe(occurredAt);
  expect(message.payload).toEqual(source.toJSON());
  expect(message.attempts).toBe(0);
});

test('retryDelay backs off exponentially from the attempts already counted by the claim', () => {
  expect(OutboxMessage.rehydrate(state({ attempts: 1 })).retryDelay(options, 0)).toBe(500);
  expect(OutboxMessage.rehydrate(state({ attempts: 1 })).retryDelay(options, 1)).toBe(1000);
  expect(OutboxMessage.rehydrate(state({ attempts: 3 })).retryDelay(options, 0)).toBe(2000);
  for (const random of [0, 0.5, 1]) {
    const delay = OutboxMessage.rehydrate(state({ attempts: 100 })).retryDelay(options, random);
    expect(delay).toBeGreaterThanOrEqual(30000);
    expect(delay).toBeLessThanOrEqual(60000);
  }
});

test('rehydrate restores persisted state without revalidating it', () => {
  const restored = OutboxMessage.rehydrate(state({ attempts: 7, eventType: 'Legacy' }));
  expect(restored.attempts).toBe(7);
  expect(restored.eventType).toBe('Legacy');
});
