import { expect, test } from 'bun:test';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { Money } from '../../src/shared/domain/money';

test('wallet factory starts at version one and rehydrate preserves state without reopening', () => {
  const wallet = Wallet.create('player-1', Money.create('100.00', 'BRL'));
  expect(wallet.toProps()).toMatchObject({
    playerId: 'player-1',
    balance: '100.00',
    currency: 'BRL',
    version: 1,
  });
  expect(Wallet.rehydrate(wallet.toProps()).toProps()).toEqual(wallet.toProps());
  expect(Wallet.create('player-zero', Money.create('0.00', 'BRL')).toProps().version).toBe(1);
  expect(() => Wallet.create('player', Money.create('1.00', 'BRL').negate())).toThrow(
    'INVALID_PAYLOAD',
  );
});
