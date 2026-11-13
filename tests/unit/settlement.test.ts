import { expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { WagerPayload } from '../../src/modules/wagering/domain/wager-payload';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { wagerStepFor } from '../../src/modules/wagering/domain/wager-step';
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
  const reference = {
    id: 'reference',
    providerId: 'provider-a',
    externalTransactionId: 'original',
    playerId: 'player',
    walletId: 'wallet',
    currency: 'BRL',
    roundId: 'round',
    kind: 'BET',
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
      ref,
      already,
    );
  };
  for (const field of ['providerId', 'playerId', 'walletId', 'currency', 'roundId'] as const)
    expect(evaluate('REFUND', { ...reference, [field]: 'different' })).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_CONTEXT_MISMATCH',
    });
  expect(evaluate('REFUND', { ...reference, money: Money.create('21.00', 'BRL') })).toMatchObject({
    failureCode: 'REFERENCE_AMOUNT_MISMATCH',
  });
  expect(evaluate('REFUND', { ...reference, kind: 'WIN' })).toMatchObject({
    failureCode: 'REFERENCE_KIND_MISMATCH',
  });
  expect(evaluate('REFUND', reference, true)).toMatchObject({ failureCode: 'ALREADY_REVERSED' });
  expect(evaluate('REFUND', undefined)).toMatchObject({ status: 'PENDING_REFERENCE' });
  expect(evaluate('WIN', reference)).toMatchObject({ status: 'PROCESSED' });
});
