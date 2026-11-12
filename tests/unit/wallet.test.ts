import { expect, test } from 'bun:test';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { Money } from '../../src/shared/domain/money';

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
  expect(result.entry!.toProps()).toMatchObject({
    direction: 'CREDIT',
    balanceBefore: '0.00',
    balanceAfter: '123.45',
    walletVersion: 1,
  });
  expect(result.event!.toJSON()).toMatchObject({
    aggregateId: result.wallet.id,
    correlationId: 'opening-correlation',
    data: {
      transactionId: result.entry!.toProps().transactionId,
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
  expect(zero.entry).toBeUndefined();
  expect(zero.event).toBeUndefined();
  expect(zero.transaction).toBeUndefined();
});
