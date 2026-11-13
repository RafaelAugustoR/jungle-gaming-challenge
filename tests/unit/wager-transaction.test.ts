import { expect, test } from 'bun:test';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { Money } from '../../src/shared/domain/money';
import { WagerPayload } from '../../src/modules/wagering/domain/wager-payload';
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
  return WagerTransaction.create({
    payload: WagerPayload.create(command),
    idempotencyKey: 'key',
    createdAt: at,
  });
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
    payload: WagerPayload.create({ ...command, money: Money.create('20.00', 'BRL') }),
    idempotencyKey: 'another-key',
    createdAt: '2026-11-12T12:01:00.000Z',
  });
  expect(transaction.matchesPayload(same.payloadHash)).toBe(true);
  const changed = WagerTransaction.create({
    payload: WagerPayload.create({ ...command, money: Money.create('21.00', 'BRL') }),
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

test('rejection receipts describe reversal and reference failures with their own messages', () => {
  const wallet = Wallet.rehydrate({
    id: 'wallet',
    playerId: 'player',
    accountId: 'account',
    currency: 'BRL',
    balance: '100.00',
    version: 1,
  });
  const cases = [
    ['REVERSAL_INSUFFICIENT_FUNDS', 'Wallet balance is insufficient to apply this reversal'],
    ['REFERENCE_NOT_FOUND', 'The reference transaction was not found'],
  ] as const;
  for (const [failureCode, message] of cases) {
    const transaction = pending();
    transaction.complete({ status: 'REJECTED', wallet, failureCode }, at, {
      correlationId: 'original',
    });
    const receipt = transaction.getReceipt();
    if (receipt.httpStatus !== 422) throw new Error('Expected rejected receipt');
    expect(receipt).toMatchObject({
      httpStatus: 422,
      body: { status: 'REJECTED', failureCode, code: failureCode, message },
    });
    expect(WagerTransaction.rehydrate(transaction.toProps()).getReceipt(true)).toEqual({
      httpStatus: 422,
      body: { ...receipt.body, idempotentReplay: true },
    });
  }
});

test('a prepared wager preserves its validated business content and canonical hash for transaction creation', () => {
  const mutable = { ...command };
  const payload = WagerPayload.create(mutable);
  mutable.externalTransactionId = 'changed-after-preparation';
  mutable.money = Money.create('21.00', 'BRL');
  const transaction = WagerTransaction.create({ payload, idempotencyKey: 'key', createdAt: at });
  expect(transaction.externalTransactionId).toBe('bet-1');
  expect(transaction.money.toProps()).toEqual({ amount: '20.00', currency: 'BRL' });
  expect(transaction.payloadHash).toBe(
    '14183b06393c64d0f231bfff5ace0fa7db4bdd384dbfdc17beda3704967045af',
  );
  expect(() =>
    WagerPayload.create({ ...command, referenceExternalTransactionId: 'another-bet' }),
  ).toThrow('INVALID_PAYLOAD');
});

test('a pending receipt survives terminal processing and resolved reference is result state', () => {
  const source = Wallet.rehydrate({
    id: 'wallet',
    playerId: 'player',
    accountId: 'account',
    currency: 'BRL',
    balance: '100.00',
    version: 1,
  });
  const transaction = WagerTransaction.create({
    payload: WagerPayload.create({
      ...command,
      kind: 'REFUND',
      referenceExternalTransactionId: 'late-bet',
    }),
    idempotencyKey: 'pending-refund',
    createdAt: at,
  });
  expect(transaction.toProps().referenceTransactionId).toBeUndefined();
  transaction.complete({ status: 'PENDING_REFERENCE', wallet: source }, at, {
    correlationId: 'first',
  });
  const original = transaction.getReceipt();
  const restored = WagerTransaction.rehydrate(transaction.toProps());
  restored.complete(
    { status: 'PROCESSED', wallet: source, referenceTransactionId: 'resolved-bet-id' },
    '2026-11-12T12:01:00.000Z',
    { correlationId: 'retry' },
  );
  expect(restored.toProps()).toMatchObject({
    status: 'PROCESSED',
    referenceTransactionId: 'resolved-bet-id',
  });
  expect(restored.resultEvent.toJSON().eventType).toBe('WagerTransactionProcessed');
  expect(restored.getReceipt()).toEqual(original);
  expect(restored.getReceipt(true).body.idempotentReplay).toBe(true);
  expect(() =>
    restored.complete(
      { status: 'PROCESSED', wallet: source, referenceTransactionId: 'another-id' },
      at,
      { correlationId: 'invalid' },
    ),
  ).toThrow('INVALID_TRANSACTION_TRANSITION');
});
