import { expect, test } from 'bun:test';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { Money } from '../../src/shared/domain/money';

test('BET debit produces a balanced journal and increments version once; zero and insufficient funds do not', () => {
  const wallet = Wallet.rehydrate({
    id: 'wallet',
    playerId: 'player',
    accountId: 'account',
    currency: 'BRL',
    balance: '100.00',
    version: 1,
  });
  const input = {
    transactionId: 'bet',
    money: Money.create('80.00', 'BRL'),
    counterpartAccountId: 'gaming',
    occurredAt: '2026-11-12T12:00:00.000Z',
    context: { correlationId: 'debit-test' },
  };
  const debited = wallet.debit(input);
  expect(debited.status).toBe('PROCESSED');
  if (debited.status !== 'PROCESSED') throw new Error('Expected processed debit');
  expect(debited.wallet.balance.toProps().amount).toBe('20.00');
  expect(debited.wallet.version).toBe(2);
  expect(debited.change!.entry.toProps()).toMatchObject({
    debitAccountId: 'account',
    creditAccountId: 'gaming',
    amount: '80.00',
    balanceBefore: '100.00',
    balanceAfter: '20.00',
    walletVersion: 2,
  });
  expect(debited.change!.event.toJSON()).toMatchObject({
    correlationId: 'debit-test',
    data: { direction: 'DEBIT', money: { amount: '80.00', currency: 'BRL' }, walletVersion: 2 },
  });
  expect(debited.wallet.debit(input)).toMatchObject({
    status: 'REJECTED',
    failureCode: 'INSUFFICIENT_FUNDS',
    wallet: debited.wallet,
  });
  const zero = wallet.debit({ ...input, money: Money.create('0.00', 'BRL') });
  expect(zero.wallet).toBe(wallet);
  expect(zero.change).toBeUndefined();
  expect(() => wallet.debit({ ...input, money: Money.create('1.00', 'USD') })).toThrow(
    'CURRENCY_MISMATCH',
  );
});

test('wallet factory validates opening while rehydrate preserves persisted state without reopening', () => {
  const input = {
    playerId: 'player-1',
    initialBalance: Money.create('100.00', 'BRL'),
    accountId: 'player',
    counterpartAccountId: 'opening',
    occurredAt: '2026-11-12T12:00:00.000Z',
    context: { correlationId: 'test' },
  };
  const { wallet } = Wallet.open(input);
  expect(wallet.toProps()).toMatchObject({
    playerId: 'player-1',
    balance: '100.00',
    currency: 'BRL',
    version: 1,
  });
  expect(
    Wallet.rehydrate({ ...wallet.toProps(), balance: '80', version: 2 }).balance.toProps().amount,
  ).toBe('80.00');
  expect(Wallet.rehydrate({ ...wallet.toProps(), balance: '80', version: 2 }).version).toBe(2);
  expect(() =>
    Wallet.open({ ...input, initialBalance: Money.create('1.00', 'BRL').negate() }),
  ).toThrow('INVALID_PAYLOAD');
  expect(() => Wallet.open({ ...input, playerId: ' ' })).toThrow('INVALID_PAYLOAD');
});

test('Wallet.open produces one financial fact shared by journal and event, or none for zero', () => {
  const result = Wallet.open({
    playerId: 'player-open',
    initialBalance: Money.create('123.45', 'BRL'),
    accountId: 'player-account',
    counterpartAccountId: 'opening-account',
    occurredAt: '2026-11-12T12:00:00.000Z',
    context: { correlationId: 'opening-correlation' },
  });
  expect(result.wallet.balance.toProps()).toEqual({ amount: '123.45', currency: 'BRL' });
  expect(result.wallet.version).toBe(1);
  expect(result.opening!.entry.toProps()).toMatchObject({
    direction: 'CREDIT',
    balanceBefore: '0.00',
    balanceAfter: '123.45',
    walletVersion: 1,
  });
  expect(result.opening!.event.toJSON()).toMatchObject({
    aggregateId: result.wallet.id,
    correlationId: 'opening-correlation',
    data: {
      transactionId: result.opening!.entry.toProps().transactionId,
      money: { amount: '123.45', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '123.45', currency: 'BRL' },
      walletVersion: 1,
    },
  });
  const zero = Wallet.open({
    playerId: 'zero',
    initialBalance: Money.create('0.00', 'BRL'),
    accountId: 'zero-account',
    counterpartAccountId: 'opening-account',
    occurredAt: '2026-11-12T12:00:00.000Z',
    context: { correlationId: 'zero' },
  });
  expect(zero.opening).toBeUndefined();
});

test('zero credits preserve wallet identity but still reject a different currency', () => {
  const wallet = Wallet.rehydrate({
    id: 'wallet',
    playerId: 'player',
    accountId: 'account',
    currency: 'BRL',
    balance: '100.00',
    version: 1,
  });
  const input = {
    transactionId: 'zero-credit',
    money: Money.create('0.00', 'BRL'),
    counterpartAccountId: 'gaming',
    occurredAt: '2026-11-12T12:00:00.000Z',
    context: { correlationId: 'zero-credit' },
  };
  expect(wallet.credit(input)).toEqual({ status: 'PROCESSED', wallet });
  expect(() => wallet.credit({ ...input, money: Money.create('0.00', 'USD') })).toThrow(
    'CURRENCY_MISMATCH',
  );
  expect(wallet.balance.toProps()).toEqual({ amount: '100.00', currency: 'BRL' });
  expect(wallet.version).toBe(1);
});

test('credit overflow is a wallet rejection and leaves its financial state unchanged', () => {
  const wallet = Wallet.rehydrate({
    id: 'wallet',
    playerId: 'player',
    accountId: 'account',
    currency: 'BRL',
    balance: '9999999999999999.99',
    version: 1,
  });
  const result = wallet.credit({
    transactionId: 'overflow',
    money: Money.create('0.01', 'BRL'),
    counterpartAccountId: 'gaming',
    occurredAt: '2026-11-12T12:00:00.000Z',
    context: { correlationId: 'overflow' },
  });
  expect(result).toEqual({ status: 'REJECTED', wallet, failureCode: 'AMOUNT_LIMIT_EXCEEDED' });
  expect(result.change).toBeUndefined();
  expect(wallet.version).toBe(1);
});
