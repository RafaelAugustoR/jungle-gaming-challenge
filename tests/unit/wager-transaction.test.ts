import { expect, test } from 'bun:test';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { Money } from '../../src/shared/domain/money';
const command = {
  providerId: 'provider-a',
  externalTransactionId: 'bet-1',
  playerId: 'player',
  walletId: 'wallet',
  roundId: 'round',
  gameId: 'game',
  kind: 'BET' as const,
  money: Money.create('20.00', 'BRL'),
};
const at = '2026-11-12T12:00:00.000Z';
function pending() {
  return WagerTransaction.create({ command, idempotencyKey: 'key', createdAt: at });
}
test('accepted transactions transition once to terminal states and cannot be reopened', () => {
  for (const status of ['PROCESSED', 'REJECTED', 'FAILED'] as const) {
    const transaction = pending();
    expect(transaction.toProps()).toMatchObject({ status: 'PENDING' });
    transaction.transition(status, status === 'PROCESSED' ? undefined : 'INSUFFICIENT_FUNDS');
    expect(transaction.toProps()).toMatchObject({
      status,
      ...(status === 'PROCESSED' ? {} : { failureCode: 'INSUFFICIENT_FUNDS' }),
    });
    const restored = WagerTransaction.rehydrate(transaction.toProps());
    for (const next of ['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'] as const)
      expect(() =>
        restored.transition(
          next,
          next === 'REJECTED' || next === 'FAILED' ? 'INSUFFICIENT_FUNDS' : undefined,
        ),
      ).toThrow('INVALID_TRANSACTION_TRANSITION');
  }
});
test('pending reference has one entry transition and terminal failures require a code', () => {
  const transaction = pending();
  expect(() => transaction.transition('REJECTED')).toThrow('INVALID_TRANSACTION_TRANSITION');
  expect(() => transaction.transition('PROCESSED', 'INSUFFICIENT_FUNDS')).toThrow(
    'INVALID_TRANSACTION_TRANSITION',
  );
  transaction.transition('PENDING_REFERENCE');
  expect(() => transaction.transition('PENDING_REFERENCE')).toThrow(
    'INVALID_TRANSACTION_TRANSITION',
  );
  transaction.transition('PROCESSED');
  expect(transaction.toProps()).toMatchObject({ status: 'PROCESSED' });
});

test('transaction owns canonical identity, its historical receipt and typed result event', () => {
  const transaction = pending();
  const same = WagerTransaction.create({
    command: { ...command, money: Money.create('20.00', 'BRL') },
    idempotencyKey: 'another-key',
    createdAt: 'later',
  });
  expect(transaction.matchesPayload(same.payloadHash)).toBe(true);
  const changed = WagerTransaction.create({
    command: { ...command, money: Money.create('21.00', 'BRL') },
    idempotencyKey: 'key',
    createdAt: at,
  });
  expect(transaction.matchesPayload(changed.payloadHash)).toBe(false);
  const wallet = Wallet.rehydrate({
    id: 'wallet',
    playerId: 'player',
    accountId: 'account',
    currency: 'BRL',
    balance: '100.00',
    version: 1,
  });
  const outcome = wallet.debit({
    transactionId: transaction.id,
    money: transaction.money,
    counterpartAccountId: 'gaming',
    occurredAt: at,
    context: { correlationId: 'original' },
  });
  transaction.complete(outcome, at, { correlationId: 'original' });
  expect(transaction.getReceipt()).toMatchObject({
    httpStatus: 200,
    body: {
      transactionId: transaction.id,
      status: 'PROCESSED',
      balance: { amount: '80.00' },
      idempotentReplay: false,
    },
  });
  expect(transaction.resultEvent.toJSON()).toMatchObject({
    eventType: 'WagerTransactionProcessed',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'bet-1',
      money: { amount: '20.00', currency: 'BRL' },
      balance: { amount: '80.00', currency: 'BRL' },
    },
  });
  const restored = WagerTransaction.rehydrate(transaction.toProps());
  expect(restored.idempotencyKey).toBe('key');
  const original = transaction.getReceipt();
  if (original.httpStatus !== 200) throw new Error('Expected processed receipt');
  expect(restored.getReceipt(true)).toEqual({
    httpStatus: 200,
    body: { ...original.body, idempotentReplay: true },
  });
  expect(() => restored.complete(outcome, at, { correlationId: 'new' })).toThrow(
    'INVALID_TRANSACTION_TRANSITION',
  );
});
