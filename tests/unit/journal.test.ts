import { expect, test } from 'bun:test';
import { JournalEntry } from '../../src/modules/wallets/domain/journal-entry';
import { Money } from '../../src/shared/domain/money';

test('journal factory preserves an exact balanced credit and rehydrate does not create a new identity', () => {
  const entry = JournalEntry.create({
    walletId: crypto.randomUUID(),
    transactionId: crypto.randomUUID(),
    debitAccountId: crypto.randomUUID(),
    creditAccountId: crypto.randomUUID(),
    money: Money.create('100.00', 'BRL'),
    balanceBefore: Money.create('0.00', 'BRL'),
    balanceAfter: Money.create('100.00', 'BRL'),
    direction: 'CREDIT',
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
    money: Money.create('100.00', 'BRL'),
    balanceBefore: Money.create('0.00', 'BRL'),
    balanceAfter: Money.create('100.00', 'BRL'),
    direction: 'CREDIT' as const,
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
