import { expect, test } from 'bun:test';
import { publicationFailure } from '../../src/messaging/outbox/publication-policy';
import { loadEventConfig } from '../../src/messaging/outbox/config';
const options = { retryBaseMs: 1000, retryMaxMs: 60000 };
const failure = (name: string) => Object.assign(new Error('sensitive'), { name });
test('only event-specific failures block; configuration outages pause the whole publisher', () => {
  for (const code of [
    'AccessDeniedException',
    'InvalidClientTokenId',
    'UnrecognizedClientException',
    'QueueDoesNotExist',
  ]) {
    expect(publicationFailure(failure(code), 1, options, 0)).toMatchObject({
      blocked: false,
      pauseWorker: true,
      delayMs: 500,
      code,
    });
  }
  expect(publicationFailure(failure('InvalidMessageContents'), 1, options, 0)).toMatchObject({
    blocked: true,
    pauseWorker: false,
  });
  expect(publicationFailure(failure('TimeoutError'), 1, options, 0)).toMatchObject({
    blocked: false,
    pauseWorker: false,
  });
});
test('retry backoff has bounded exponential growth and jitter', () => {
  expect(publicationFailure(failure('TimeoutError'), 3, options, 0).delayMs).toBe(2000);
  expect(publicationFailure(failure('TimeoutError'), 100, options, 1).delayMs).toBe(60000);
});
test('consumer configuration ignores publisher-only invalid settings', () => {
  expect(
    loadEventConfig({ OUTBOX_LEASE_MS: 'invalid', OUTBOX_SEND_TIMEOUT_MS: 'invalid' }).queueName,
  ).toBe('wager-events.fifo');
});

test('consumer parses the concrete event contract including optional causation', async () => {
  const { WagerTransactionProcessed } =
    await import('../../src/modules/wagering/domain/events/wager-events');
  const { Money } = await import('../../src/shared/domain/money');
  const { parseIntegrationEvent } = await import('../../src/messaging/events/integration-envelope');
  const event = WagerTransactionProcessed.from(
    {
      providerId: 'p',
      externalTransactionId: 'e',
      walletId: crypto.randomUUID(),
      playerId: 'player',
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: Money.create('1.00', 'BRL'),
    },
    crypto.randomUUID(),
    { amount: '9.00', currency: 'BRL' },
    new Date().toISOString(),
    { correlationId: 'correlation', causationId: 'command' },
  ).toJSON();
  const envelope = { ...event, eventType: 'WagerTransactionProcessed' as const, sequence: 1 };
  expect(parseIntegrationEvent(JSON.stringify(envelope))).toEqual(envelope);
  expect(() => parseIntegrationEvent(JSON.stringify({ ...envelope, causationId: 123 }))).toThrow(
    'INVALID_INTEGRATION_EVENT',
  );
  expect(() => parseIntegrationEvent(JSON.stringify({ ...envelope, data: {} }))).toThrow(
    'INVALID_INTEGRATION_EVENT',
  );
});

test('ambiguous invalid parameters retry while proven size failures block only the event', () => {
  expect(publicationFailure(failure('InvalidParameterValue'), 1, options, 0)).toMatchObject({
    blocked: false,
    pauseWorker: true,
  });
  expect(publicationFailure(failure('MessageTooLarge'), 1, options, 0)).toMatchObject({
    blocked: true,
    pauseWorker: false,
  });
});
test('polling uses the same decimal integer grammar as publisher timing', () => {
  for (const value of ['1e3', '1.0', ' 1000', '0'])
    expect(() => loadEventConfig({ OUTBOX_POLL_MS: value })).toThrow();
  expect(loadEventConfig({ OUTBOX_POLL_MS: '1000' }).pollMs).toBe(1000);
});

test('consumer accepts every canonical wager kind without a duplicate local list', async () => {
  const { wagerKinds } = await import('../../src/modules/wagering/domain/wager-command');
  const { WagerTransactionProcessed } =
    await import('../../src/modules/wagering/domain/events/wager-events');
  const { Money } = await import('../../src/shared/domain/money');
  const { parseIntegrationEvent } = await import('../../src/messaging/events/integration-envelope');
  for (const kind of wagerKinds) {
    const event = WagerTransactionProcessed.from(
      {
        providerId: 'p',
        externalTransactionId: 'e',
        walletId: crypto.randomUUID(),
        playerId: 'player',
        roundId: 'r',
        gameId: 'g',
        kind,
        money: Money.create('1.00', 'BRL'),
      },
      crypto.randomUUID(),
      { amount: '9.00', currency: 'BRL' },
      new Date().toISOString(),
      { correlationId: 'c' },
    ).toJSON();
    const parsed = parseIntegrationEvent(JSON.stringify({ ...event, sequence: 1 }));
    expect(parsed.eventType).toBe(WagerTransactionProcessed.eventType);
    if (parsed.eventType === WagerTransactionProcessed.eventType)
      expect(parsed.data.kind).toBe(kind);
  }
});
