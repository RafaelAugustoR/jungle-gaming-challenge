import { expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { WagerPayload } from '../../src/modules/wagering/domain/wager-payload';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { type WagerReference, wagerStepFor } from '../../src/modules/wagering/domain/wager-step';
const wallet = Wallet.rehydrate({
  id: 'wallet',
  playerId: 'player',
  accountId: 'player-account',
  currency: 'BRL',
  balance: '100.00',
  version: 1,
});
const base = {
  providerId: 'provider-a',
  externalTransactionId: 'external',
  playerId: 'player',
  walletId: 'wallet',
  roundId: 'round',
  gameId: 'game',
  money: Money.create('20.00', 'BRL'),
};
const at = '2026-11-12T00:00:00.000Z';
for (const [kind, balance, version] of [
  ['WIN', '120.00', 2],
  ['LOSS', '100.00', 1],
] as const) {
  test(`${kind} applies its financial effect and typed result`, () => {
    const command = { ...base, kind };
    const transaction = WagerTransaction.create({
      payload: WagerPayload.create(command),
      idempotencyKey: 'key',
      createdAt: at,
    });
    const result = wagerStepFor(kind).apply(
      transaction,
      wallet,
      { counterpartAccountId: 'gaming', occurredAt: at },
      { correlationId: 'request' },
    );
    expect(result.wallet.balance.toProps().amount).toBe(balance);
    expect(result.wallet.version).toBe(version);
    transaction.complete(result, at, { correlationId: 'request' });
    expect(transaction.resultEvent.toJSON().eventType).toBe('WagerTransactionProcessed');
  });
}

test('references validate every shared context field and reversal-specific rules', () => {
  const reference: WagerReference = {
    id: 'reference',
    providerId: 'provider-a',
    externalTransactionId: 'original',
    playerId: 'player',
    walletId: 'wallet',
    currency: 'BRL',
    roundId: 'round',
    kind: 'BET' as const,
    reversedBy: new Set<import('../../src/modules/wagering/domain/wager-command').WagerKind>(),
    status: 'PROCESSED' as const,
    money: Money.create('20.00', 'BRL'),
  };
  const evaluate = (
    kind: 'REFUND' | 'ROLLBACK' | 'WIN' | 'LOSS',
    ref: typeof reference | undefined,
    already = false,
  ) => {
    const transaction = WagerTransaction.create({
      payload: WagerPayload.create({ ...base, kind, referenceExternalTransactionId: 'original' }),
      idempotencyKey: 'key',
      createdAt: at,
    });
    return wagerStepFor(kind).apply(
      transaction,
      wallet,
      { counterpartAccountId: 'gaming', occurredAt: at },
      { correlationId: 'request' },
      ref && { ...ref, reversedBy: new Set(already ? [kind] : []) },
    );
  };
  for (const field of ['playerId', 'walletId', 'currency', 'roundId'] as const)
    expect(evaluate('REFUND', { ...reference, [field]: 'different' })).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_CONTEXT_MISMATCH',
    });
  expect(evaluate('REFUND', { ...reference, money: Money.create('21.00', 'BRL') })).toMatchObject({
    failureCode: 'REFERENCE_AMOUNT_MISMATCH',
  });
  expect(evaluate('REFUND', { ...reference, kind: 'WIN' as const })).toMatchObject({
    failureCode: 'REFERENCE_KIND_MISMATCH',
  });
  expect(evaluate('REFUND', reference, true)).toMatchObject({ failureCode: 'ALREADY_REVERSED' });
  for (const status of ['REJECTED', 'FAILED'] as const)
    expect(evaluate('REFUND', { ...reference, status })).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_PROCESSED',
    });
  expect(evaluate('REFUND', undefined)).toMatchObject({ status: 'PENDING_REFERENCE' });
  expect(evaluate('WIN', reference)).toMatchObject({ status: 'PROCESSED' });
});

test('reference expiration is pure and retains the known reference identity', () => {
  const transaction = WagerTransaction.create({
    payload: WagerPayload.create({
      ...base,
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'original',
    }),
    idempotencyKey: 'key',
    createdAt: at,
  });
  const reference: WagerReference = {
    id: 'reference',
    providerId: 'provider-a',
    externalTransactionId: 'original',
    playerId: 'player',
    walletId: 'wallet',
    currency: 'BRL',
    roundId: 'round',
    kind: 'WIN',
    status: 'PENDING_REFERENCE',
    money: Money.create('20.00', 'BRL'),
    reversedBy: new Set(),
  };
  const resources = { counterpartAccountId: 'gaming', occurredAt: '2026-11-12T00:16:00.000Z' };
  const step = wagerStepFor('ROLLBACK');
  const expired = step.apply(
    transaction,
    wallet,
    resources,
    { correlationId: 'request' },
    reference,
    '2026-11-12T00:15:00.000Z',
  );
  expect(expired).toMatchObject({
    status: 'REJECTED',
    failureCode: 'REFERENCE_NOT_READY',
    referenceTransactionId: 'reference',
  });
  expect(
    step.apply(
      transaction,
      wallet,
      resources,
      { correlationId: 'request' },
      undefined,
      '2026-11-12T00:15:00.000Z',
    ),
  ).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
  expect(
    step.apply(
      transaction,
      wallet,
      { ...resources, occurredAt: at },
      { correlationId: 'request' },
      reference,
      '2026-11-12T00:15:00.000Z',
    ),
  ).toMatchObject({ status: 'PENDING_REFERENCE' });
});

test('reversals apply the full inverse of a processed reference', () => {
  const reference = (kind: 'BET' | 'WIN' | 'REFUND'): WagerReference => ({
    id: `reference-${kind}`,
    providerId: 'provider-a',
    externalTransactionId: 'original',
    playerId: 'player',
    walletId: 'wallet',
    currency: 'BRL',
    roundId: 'round',
    kind,
    status: 'PROCESSED',
    money: Money.create('20.00', 'BRL'),
    reversedBy: new Set(),
  });
  const reverse = (kind: 'REFUND' | 'ROLLBACK', target: WagerReference, from = wallet) => {
    const transaction = WagerTransaction.create({
      payload: WagerPayload.create({ ...base, kind, referenceExternalTransactionId: 'original' }),
      idempotencyKey: 'key',
      createdAt: at,
    });
    const result = wagerStepFor(kind).apply(
      transaction,
      from,
      { counterpartAccountId: 'gaming', occurredAt: at },
      { correlationId: 'request' },
      target,
    );
    return { transaction, result };
  };
  for (const [kind, target, balance, direction] of [
    ['REFUND', 'BET', '120.00', 'CREDIT'],
    ['ROLLBACK', 'BET', '120.00', 'CREDIT'],
    ['ROLLBACK', 'WIN', '80.00', 'DEBIT'],
    ['ROLLBACK', 'REFUND', '80.00', 'DEBIT'],
  ] as const) {
    const { transaction, result } = reverse(kind, reference(target));
    expect(result).toMatchObject({
      status: 'PROCESSED',
      referenceTransactionId: `reference-${target}`,
    });
    if (result.status !== 'PROCESSED') throw new Error('expected processed reversal');
    expect(result.wallet.balance.toProps()).toEqual({ amount: balance, currency: 'BRL' });
    expect(result.wallet.version).toBe(2);
    expect(result.change?.event.toJSON().data).toMatchObject({
      direction,
      money: { amount: '20.00', currency: 'BRL' },
    });
    transaction.complete(result, at, { correlationId: 'request' });
    expect(transaction.resultEvent.toJSON().eventType).toBe('WagerTransactionProcessed');
  }
  const poor = Wallet.rehydrate({
    id: 'wallet',
    playerId: 'player',
    accountId: 'player-account',
    currency: 'BRL',
    balance: '10.00',
    version: 3,
  });
  const { result } = reverse('ROLLBACK', reference('WIN'), poor);
  expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS' });
  expect(result.wallet.balance.toProps().amount).toBe('10.00');
  expect(result.wallet.version).toBe(3);
  expect(result.change).toBeUndefined();
});
