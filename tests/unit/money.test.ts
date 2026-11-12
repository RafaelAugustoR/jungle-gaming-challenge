import { expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';

test('Money preserves exact precision at the limit and rejects overflow', () => {
  const amount = Money.create('9999999999999999.98', 'BRL');
  expect(amount.add(Money.create('0.01', 'BRL')).toProps()).toEqual({
    amount: '9999999999999999.99',
    currency: 'BRL',
  });
  expect(() => amount.add(Money.create('0.02', 'BRL'))).toThrow('AMOUNT_LIMIT_EXCEEDED');
  expect(amount.toProps().amount).toBe('9999999999999999.98');
});

test('Money rejects noncanonical inputs instead of rounding or accepting numeric values', () => {
  for (const amount of [
    '0.001',
    'NaN',
    'Infinity',
    '1e2',
    ' 1.00',
    '+1.00',
    '-1.00',
    '01.00',
    '1',
    '1.0',
    1,
    null,
  ]) {
    expect(() => Money.create(amount as string, 'BRL')).toThrow('INVALID_PAYLOAD');
  }
  expect(() => Money.create('10000000000000000.00', 'BRL')).toThrow('AMOUNT_LIMIT_EXCEEDED');
  expect(() => Money.create('1.00', 'brl')).toThrow('INVALID_PAYLOAD');
});

test('Money factories and rehydrate preserve currency and allow signed internal arithmetic', () => {
  const amount = Money.rehydrate({ amount: '0.30', currency: 'BRL' });
  expect(amount.subtract(Money.create('0.20', 'BRL')).toProps().amount).toBe('0.10');
  expect(amount.negate().toProps().amount).toBe('-0.30');
  expect(() => amount.add(Money.create('0.01', 'USD'))).toThrow('CURRENCY_MISMATCH');
  expect(() => amount.subtract(Money.create('0.01', 'USD'))).toThrow('CURRENCY_MISMATCH');
});
