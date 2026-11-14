import { expect, test } from 'bun:test';
import { InboxMessage } from '../../src/messaging/domain/inbox-message';

const props = {
  consumerName: 'wager-commands',
  messageId: 'message-1',
  payloadHash: 'a'.repeat(64),
  transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
};

test('a recorded message keeps its identity, payload hash and resulting transaction', () => {
  expect(InboxMessage.record(props)).toMatchObject(props);
});

test('record rejects missing identity, missing transaction and malformed hashes', () => {
  for (const invalid of [
    { ...props, consumerName: ' ' },
    { ...props, messageId: '' },
    { ...props, transactionId: '' },
    { ...props, payloadHash: 'short' },
    { ...props, payloadHash: 'A'.repeat(64) },
  ])
    expect(() => InboxMessage.record(invalid)).toThrow('INVALID_PAYLOAD');
});
