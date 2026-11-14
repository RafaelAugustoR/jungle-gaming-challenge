import { expect, test } from 'bun:test';
import { InboxMessage } from '../../src/messaging/domain/inbox-message';

const hash = 'a'.repeat(64);
const receivedAt = '2026-11-14T10:00:00.000Z';
const props = {
  consumerName: 'wager-commands',
  messageId: 'message-1',
  payloadHash: hash,
  receivedAt,
};

test('a received message is unprocessed and keeps its identity and payload hash', () => {
  const message = InboxMessage.receive(props);
  expect(message).toMatchObject(props);
  expect(message.isProcessed()).toBe(false);
  expect(message.processedAt).toBeUndefined();
  expect(message.transactionId).toBeUndefined();
  expect(message.matchesPayload(hash)).toBe(true);
  expect(message.matchesPayload('b'.repeat(64))).toBe(false);
});

test('receive rejects missing identity, malformed hashes and invalid timestamps', () => {
  for (const invalid of [
    { ...props, consumerName: ' ' },
    { ...props, messageId: '' },
    { ...props, payloadHash: 'short' },
    { ...props, payloadHash: 'A'.repeat(64) },
    { ...props, receivedAt: 'yesterday' },
  ])
    expect(() => InboxMessage.receive(invalid)).toThrow('INVALID_PAYLOAD');
});

test('a message is marked processed once with the transaction it produced', () => {
  const processedAt = '2026-11-14T10:00:01.000Z';
  const message = InboxMessage.receive(props).markProcessed(processedAt, 'transaction-1');
  expect(message.isProcessed()).toBe(true);
  expect(message.processedAt).toBe(processedAt);
  expect(message.transactionId).toBe('transaction-1');
  expect(() => message.markProcessed(processedAt, 'transaction-2')).toThrow(
    'INVALID_MESSAGE_TRANSITION',
  );
  expect(message.transactionId).toBe('transaction-1');
});

test('rehydrate restores persisted state without revalidating it', () => {
  const restored = InboxMessage.rehydrate({
    ...props,
    payloadHash: 'legacy',
    processedAt: receivedAt,
    transactionId: 'transaction-1',
  });
  expect(restored.payloadHash).toBe('legacy');
  expect(restored.isProcessed()).toBe(true);
  expect(() => restored.markProcessed(receivedAt)).toThrow('INVALID_MESSAGE_TRANSITION');
  expect(InboxMessage.rehydrate(props).isProcessed()).toBe(false);
});
