import { expect, test } from 'bun:test';
import { publicationFailure } from '../../src/messaging/outbox/publication-policy';
import { retryDelay } from '../../src/messaging/domain/retry-backoff';
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
    expect(publicationFailure(failure(code))).toMatchObject({
      blocked: false,
      pauseWorker: true,
      code,
    });
  }
  expect(publicationFailure(failure('InvalidMessageContents'))).toMatchObject({
    blocked: true,
    pauseWorker: false,
  });
  expect(publicationFailure(failure('TimeoutError'))).toMatchObject({
    blocked: false,
    pauseWorker: false,
  });
});
test('retry backoff has bounded exponential growth and jitter', () => {
  expect(retryDelay(1, options, 0)).toBe(500);
  expect(retryDelay(3, options, 0)).toBe(2000);
  expect(retryDelay(100, options, 1)).toBe(60000);
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
  expect(publicationFailure(failure('InvalidParameterValue'))).toMatchObject({
    blocked: false,
    pauseWorker: true,
  });
  expect(publicationFailure(failure('MessageTooLarge'))).toMatchObject({
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

test('consumer accepts the internal OPENING result and rejects it with provider identity or another type', async () => {
  const { Wallet } = await import('../../src/modules/wallets/domain/wallet');
  const { Money } = await import('../../src/shared/domain/money');
  const { parseIntegrationEvent } = await import('../../src/messaging/events/integration-envelope');
  const opened = Wallet.open({
    playerId: 'player',
    initialBalance: Money.create('100.00', 'BRL'),
    accountId: crypto.randomUUID(),
    counterpartAccountId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    context: { correlationId: 'c' },
  });
  const [balanceChanged, processed] = opened.opening!.events;
  const envelope = { ...processed.toJSON(), sequence: 2 };
  expect(parseIntegrationEvent(JSON.stringify(envelope))).toEqual(envelope as never);
  expect(
    parseIntegrationEvent(JSON.stringify({ ...balanceChanged.toJSON(), sequence: 1 })).eventType,
  ).toBe('WalletBalanceChanged');
  for (const invalid of [
    { ...envelope, eventType: 'WagerTransactionRejected' },
    { ...envelope, data: { ...envelope.data, providerId: 'p' } },
    { ...envelope, data: { ...envelope.data, money: { amount: '0.00', currency: 'BRL' } } },
    { ...envelope, data: { ...envelope.data, playerId: '' } },
  ])
    expect(() => parseIntegrationEvent(JSON.stringify(invalid))).toThrow('INVALID_INTEGRATION_EVENT');
});
