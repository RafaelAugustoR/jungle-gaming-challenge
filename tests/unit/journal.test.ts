import { expect, test } from 'bun:test';
import { JournalEntry } from '../../src/modules/wallets/domain/journal-entry';
import { Money } from '../../src/shared/domain/money';

test('journal factory preserves an exact balanced credit and rehydrate does not create a new identity', () => {
  const entry = JournalEntry.create({
    walletId: crypto.randomUUID(),
    transactionId: crypto.randomUUID(),
    debitAccountId: crypto.randomUUID(),
    creditAccountId: 'player',
    playerAccountId: 'player',
    money: Money.create('100.00', 'BRL'),
    balanceBefore: Money.create('0.00', 'BRL'),
    balanceAfter: Money.create('100.00', 'BRL'),

    walletVersion: 1,
  });
  expect(entry.toProps()).toMatchObject({
    amount: '100.00',
    balanceBefore: '0.00',
    balanceAfter: '100.00',
    currency: 'BRL',
  });
  expect(JournalEntry.rehydrate(entry.toProps()).toProps()).toEqual(entry.toProps());
});

test('journal rejects mismatched currency, incorrect arithmetic, self transfer and zero entry', () => {
  const input = {
    walletId: crypto.randomUUID(),
    transactionId: crypto.randomUUID(),
    debitAccountId: 'debit',
    creditAccountId: 'credit',
    playerAccountId: 'credit',
    money: Money.create('100.00', 'BRL'),
    balanceBefore: Money.create('0.00', 'BRL'),
    balanceAfter: Money.create('100.00', 'BRL'),

    walletVersion: 1,
  };
  expect(() =>
    JournalEntry.create({ ...input, balanceAfter: Money.create('99.00', 'BRL') }),
  ).toThrow('UNBALANCED_JOURNAL');
  expect(() =>
    JournalEntry.create({ ...input, balanceAfter: Money.create('100.00', 'USD') }),
  ).toThrow('CURRENCY_MISMATCH');
  expect(() => JournalEntry.create({ ...input, creditAccountId: 'debit' })).toThrow(
    'UNBALANCED_JOURNAL',
  );
  expect(() => JournalEntry.create({ ...input, money: Money.create('0.00', 'BRL') })).toThrow(
    'UNBALANCED_JOURNAL',
  );
});

test('journal derives player direction from the account pair', () => {
  const entry = JournalEntry.create({
    walletId: crypto.randomUUID(),
    transactionId: crypto.randomUUID(),
    playerAccountId: 'player',
    debitAccountId: 'player',
    creditAccountId: 'gaming',
    money: Money.create('20.00', 'BRL'),
    balanceBefore: Money.create('100.00', 'BRL'),
    balanceAfter: Money.create('80.00', 'BRL'),
    walletVersion: 2,
  });
  expect(entry.direction).toBe('DEBIT');
  expect(entry.toProps().balanceAfter).toBe('80.00');
});
