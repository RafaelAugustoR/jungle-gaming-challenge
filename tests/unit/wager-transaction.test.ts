import { expect, test } from 'bun:test';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
test('accepted transactions transition once to terminal states and cannot be reopened', () => {
  for (const status of ['PROCESSED', 'REJECTED', 'FAILED'] as const) {
    const transaction = WagerTransaction.create();
    expect(transaction.toProps()).toEqual({ status: 'PENDING' });
    transaction.transition(status, status === 'PROCESSED' ? undefined : 'TEST_FAILURE');
    expect(transaction.toProps()).toEqual({
      status,
      ...(status === 'PROCESSED' ? {} : { failureCode: 'TEST_FAILURE' }),
    });
    const restored = WagerTransaction.rehydrate(transaction.id, transaction.toProps());
    for (const next of ['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'] as const)
      expect(() =>
        restored.transition(next, next === 'REJECTED' || next === 'FAILED' ? 'TEST' : undefined),
      ).toThrow('INVALID_TRANSACTION_TRANSITION');
  }
});
test('pending reference has one entry transition and terminal failures require a code', () => {
  const transaction = WagerTransaction.create();
  expect(() => transaction.transition('REJECTED')).toThrow('INVALID_TRANSACTION_TRANSITION');
  expect(() => transaction.transition('PROCESSED', 'ERROR')).toThrow(
    'INVALID_TRANSACTION_TRANSITION',
  );
  transaction.transition('PENDING_REFERENCE');
  expect(() => transaction.transition('PENDING_REFERENCE')).toThrow(
    'INVALID_TRANSACTION_TRANSITION',
  );
  transaction.transition('PROCESSED');
  expect(transaction.toProps()).toEqual({ status: 'PROCESSED' });
});
