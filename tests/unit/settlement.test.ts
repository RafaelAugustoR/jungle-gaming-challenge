import { expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { WagerPayload } from '../../src/modules/wagering/domain/wager-payload';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { type WagerReference, wagerStepFor } from '../../src/modules/wagering/domain/wager-step';
import type { WagerKind } from '../../src/modules/wagering/domain/wager-command';
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
const deadline = '2026-11-12T00:15:00.000Z';

// A processed BET reference in the same context; tests override only the field under scrutiny.
const reference = (overrides: Partial<WagerReference> = {}): WagerReference => ({
  id: 'reference',
  providerId: 'provider-a',
  externalTransactionId: 'original',
  playerId: 'player',
  walletId: 'wallet',
  currency: 'BRL',
  roundId: 'round',
  kind: 'BET',
  status: 'PROCESSED',
  money: Money.create('20.00', 'BRL'),
  reversedBy: new Set<WagerKind>(),
  ...overrides,
});

function applyStep(
  kind: WagerKind,
  options: {
    reference?: WagerReference;
    referenced?: boolean;
    from?: Wallet;
    occurredAt?: string;
    deadline?: string;
  } = {},
) {
  const referenced = options.referenced ?? true;
  const transaction = WagerTransaction.create({
    payload: WagerPayload.create({
      ...base,
      kind,
      ...(referenced ? { referenceExternalTransactionId: 'original' } : {}),
    }),
    idempotencyKey: 'key',
    createdAt: at,
  });
  const result = wagerStepFor(kind).apply(
    transaction,
    options.from ?? wallet,
    { counterpartAccountId: 'gaming', occurredAt: options.occurredAt ?? at },
    { correlationId: 'request' },
    options.reference,
    options.deadline,
  );
  return { transaction, result };
}

for (const [kind, balance, version] of [
  ['WIN', '120.00', 2],
  ['LOSS', '100.00', 1],
] as const) {
  test(`${kind} applies its financial effect and typed result`, () => {
    const { transaction, result } = applyStep(kind, { referenced: false });
    expect(result.wallet.balance.toProps().amount).toBe(balance);
    expect(result.wallet.version).toBe(version);
    transaction.complete(result, at, { correlationId: 'request' });
    expect(transaction.resultEvent.toJSON().eventType).toBe('WagerTransactionProcessed');
  });
}

test('references validate every shared context field and reversal-specific rules', () => {
  const evaluate = (kind: WagerKind, target?: WagerReference) =>
    applyStep(kind, { reference: target }).result;
  for (const field of ['playerId', 'walletId', 'currency', 'roundId'] as const)
    expect(evaluate('REFUND', reference({ [field]: 'different' }))).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_CONTEXT_MISMATCH',
    });
  for (const [overrides, failureCode] of [
    [{ money: Money.create('21.00', 'BRL') }, 'REFERENCE_AMOUNT_MISMATCH'],
    [{ kind: 'WIN' }, 'REFERENCE_KIND_MISMATCH'],
    [{ reversedBy: new Set<WagerKind>(['REFUND']) }, 'ALREADY_REVERSED'],
    [{ status: 'REJECTED' }, 'REFERENCE_NOT_PROCESSED'],
    [{ status: 'FAILED' }, 'REFERENCE_NOT_PROCESSED'],
  ] as const satisfies readonly (readonly [Partial<WagerReference>, string])[])
    expect(evaluate('REFUND', reference(overrides))).toMatchObject({
      status: 'REJECTED',
      failureCode,
    });
  expect(evaluate('REFUND')).toMatchObject({ status: 'PENDING_REFERENCE' });
  expect(evaluate('WIN', reference())).toMatchObject({ status: 'PROCESSED' });
});

test('reference expiration is pure and retains the known reference identity', () => {
  const pendingWin = reference({ kind: 'WIN', status: 'PENDING_REFERENCE' });
  const late = '2026-11-12T00:16:00.000Z';
  expect(
    applyStep('ROLLBACK', { reference: pendingWin, occurredAt: late, deadline }).result,
  ).toMatchObject({
    status: 'REJECTED',
    failureCode: 'REFERENCE_NOT_READY',
    referenceTransactionId: 'reference',
  });
  expect(applyStep('ROLLBACK', { occurredAt: late, deadline }).result).toMatchObject({
    status: 'REJECTED',
    failureCode: 'REFERENCE_NOT_FOUND',
  });
  expect(applyStep('ROLLBACK', { reference: pendingWin, deadline }).result).toMatchObject({
    status: 'PENDING_REFERENCE',
  });
});

test('reversals apply the full inverse of a processed reference', () => {
  for (const [kind, target, balance, direction] of [
    ['REFUND', 'BET', '120.00', 'CREDIT'],
    ['ROLLBACK', 'BET', '120.00', 'CREDIT'],
    ['ROLLBACK', 'WIN', '80.00', 'DEBIT'],
    ['ROLLBACK', 'REFUND', '80.00', 'DEBIT'],
  ] as const) {
    const { transaction, result } = applyStep(kind, {
      reference: reference({ id: `reference-${target}`, kind: target }),
    });
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
  const { result } = applyStep('ROLLBACK', { reference: reference({ kind: 'WIN' }), from: poor });
  expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS' });
  expect(result.wallet.balance.toProps().amount).toBe('10.00');
  expect(result.wallet.version).toBe(3);
  expect(result.change).toBeUndefined();
});
