import { describe, expect, test } from 'bun:test';
import {
  formatAmount,
  formatMoney,
  fromMinor,
  parseAmountInput,
  toMinor,
} from '../../frontend/src/money';
import {
  isViewId,
  judgeDuplicate,
  judgeRace,
  judgeReconciliation,
  judgeRecovery,
  judgeReference,
  proofById,
  proofs,
  type ScenarioEvidence,
} from '../../frontend/src/proofs';
import { can } from '../../frontend/src/roles';
import type { DemoScenarioResult, DemoSubmission, TransactionView } from '../../frontend/src/types';

const brl = (amount: string) => ({ amount, currency: 'BRL' });

function receipt(
  transactionId: string,
  status: 'PROCESSED' | 'PENDING_REFERENCE' | 'REJECTED',
  options: { replay?: boolean; balance?: string } = {},
): DemoSubmission {
  const body = {
    transactionId,
    balance: brl(options.balance ?? '0.00'),
    idempotentReplay: options.replay ?? false,
  };
  if (status === 'PROCESSED')
    return { httpStatus: 200, originalReceipt: { httpStatus: 200, body: { ...body, status } } };
  if (status === 'PENDING_REFERENCE')
    return { httpStatus: 202, originalReceipt: { httpStatus: 202, body: { ...body, status } } };
  return {
    httpStatus: 422,
    originalReceipt: {
      httpStatus: 422,
      body: {
        ...body,
        status,
        failureCode: 'INSUFFICIENT_FUNDS',
        code: 'INSUFFICIENT_FUNDS',
        message: 'insufficient',
        correlationId: 'c',
      },
    },
  } as DemoSubmission;
}

function view(
  transactionId: string,
  status: TransactionView['status'],
  failureCode?: string,
): TransactionView {
  return { transactionId, status, failureCode: failureCode ?? null } as unknown as TransactionView;
}

function result(
  scenario: DemoScenarioResult['scenario'],
  amount: string,
  transactions: DemoSubmission[],
) {
  return { auditId: 'a', scenario, providerId: 'provider-a', amount: brl(amount), transactions };
}

describe('money formatting keeps decimal strings exact', () => {
  test('formats pt-BR amounts with grouping', () => {
    expect(formatAmount('1234567.50')).toBe('1.234.567,50');
    expect(formatAmount('0.05')).toBe('0,05');
    expect(formatMoney(brl('100.00'))).toBe('R$ 100,00');
  });
  test('converts between decimal strings and minor units without floats', () => {
    expect(toMinor('80.01')).toBe(8001n);
    expect(fromMinor(-5n)).toBe('-0.05');
    expect(() => toMinor('1.5')).toThrow();
  });
  test.each([
    ['20', '20.00'],
    ['20,5', '20.50'],
    ['1.234,56', '1234.56'],
    ['R$ 7,25', '7.25'],
    ['007,10', '7.10'],
  ])('parses operator input %p as %p', (input, expected) => {
    expect(parseAmountInput(input)).toBe(expected);
  });
  test.each(['', 'abc', '1,234', '2,345,6', '-5,00', '1.2.3'])(
    'rejects invalid input %p',
    (input) => {
      expect(parseAmountInput(input)).toBeUndefined();
    },
  );
});

describe('race proof', () => {
  const run = result('race', '80.00', [receipt('a', 'PROCESSED'), receipt('b', 'REJECTED')]);
  test('holds with one debit and one insufficient-funds rejection', () => {
    const verdict = judgeRace({
      result: run,
      views: [view('a', 'PROCESSED'), view('b', 'REJECTED', 'INSUFFICIENT_FUNDS')],
      before: brl('100.00'),
      after: brl('20.00'),
      pendingMs: 0,
    });
    expect(verdict.outcome).toBe('held');
    expect(verdict.headline).toContain('R$ 80,00');
  });
  test('is violated when both bets debited', () => {
    const verdict = judgeRace({
      result: run,
      views: [view('a', 'PROCESSED'), view('b', 'PROCESSED')],
      before: brl('100.00'),
      after: brl('-60.00'),
      pendingMs: 0,
    });
    expect(verdict.outcome).toBe('violated');
  });
  test('is inconclusive when a current state could not be read', () => {
    const verdict = judgeRace({
      result: run,
      views: [view('a', 'PROCESSED'), undefined],
      before: brl('100.00'),
      after: brl('20.00'),
      pendingMs: 0,
    });
    expect(verdict.outcome).toBe('inconclusive');
  });
});

describe('duplicate proof', () => {
  test('holds with a single transaction, one replay and one debit', () => {
    const verdict = judgeDuplicate({
      result: result('duplicate', '5.00', [
        receipt('t', 'PROCESSED'),
        receipt('t', 'PROCESSED', { replay: true }),
      ]),
      views: [view('t', 'PROCESSED'), view('t', 'PROCESSED')],
      before: brl('20.00'),
      after: brl('15.00'),
      pendingMs: 0,
    });
    expect(verdict.outcome).toBe('held');
  });
  test('holds when the single transaction was rejected and nothing moved', () => {
    const verdict = judgeDuplicate({
      result: result('duplicate', '50.00', [
        receipt('t', 'REJECTED'),
        receipt('t', 'REJECTED', { replay: true }),
      ]),
      views: [
        view('t', 'REJECTED', 'INSUFFICIENT_FUNDS'),
        view('t', 'REJECTED', 'INSUFFICIENT_FUNDS'),
      ],
      before: brl('20.00'),
      after: brl('20.00'),
      pendingMs: 0,
    });
    expect(verdict.outcome).toBe('held');
  });
  test('is violated when two transactions were created', () => {
    const verdict = judgeDuplicate({
      result: result('duplicate', '5.00', [receipt('t1', 'PROCESSED'), receipt('t2', 'PROCESSED')]),
      views: [view('t1', 'PROCESSED'), view('t2', 'PROCESSED')],
      before: brl('20.00'),
      after: brl('10.00'),
      pendingMs: 0,
    });
    expect(verdict.outcome).toBe('violated');
  });
});

describe('out-of-order and recovery proofs', () => {
  const run = result('out-of-order', '5.00', [
    receipt('r', 'PENDING_REFERENCE'),
    receipt('b', 'PROCESSED'),
  ]);
  const resolved = [view('r', 'PROCESSED'), view('b', 'PROCESSED')];
  const evidence = (
    judge: (evidence: ScenarioEvidence) => { outcome: string },
    pendingMs: number,
    views = resolved,
  ) =>
    judge({
      result: run,
      views,
      before: brl('15.00'),
      after: brl('15.00'),
      pendingMs,
    });

  test('out-of-order holds when the deferred refund resolves and the balance nets to zero', () => {
    expect(evidence(judgeReference, 0).outcome).toBe('held');
  });
  test('stays inconclusive while the refund is still pending', () => {
    const pending = [view('r', 'PENDING_REFERENCE'), view('b', 'PROCESSED')];
    expect(evidence(judgeReference, 200, pending).outcome).toBe('inconclusive');
  });
  test('recovery needs the refund to stay pending longer than a normal worker cycle', () => {
    expect(evidence(judgeRecovery, 0).outcome).toBe('inconclusive');
    expect(evidence(judgeRecovery, 300).outcome).toBe('inconclusive');
    expect(evidence(judgeRecovery, 42_000).outcome).toBe('held');
  });
  test('is violated when the refund was not deferred', () => {
    const immediate = result('out-of-order', '5.00', [
      receipt('r', 'PROCESSED'),
      receipt('b', 'PROCESSED'),
    ]);
    const verdict = judgeReference({
      result: immediate,
      views: resolved,
      before: brl('15.00'),
      after: brl('15.00'),
      pendingMs: 0,
    });
    expect(verdict.outcome).toBe('violated');
  });
});

describe('reconciliation proof', () => {
  test('holds when the ledger rebuilds the stored balance', () => {
    const verdict = judgeReconciliation({
      storedBalance: brl('15.00'),
      calculatedBalance: brl('15.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 7,
    });
    expect(verdict.outcome).toBe('held');
    expect(verdict.headline).toContain('7 lançamentos');
  });
  test('is violated on divergence', () => {
    expect(
      judgeReconciliation({
        storedBalance: brl('15.00'),
        calculatedBalance: brl('10.00'),
        difference: brl('5.00'),
        consistent: false,
        checkedEntries: 7,
      }).outcome,
    ).toBe('violated');
  });
});

describe('proof table', () => {
  test('every proof carries its own judge, permission and tickets', () => {
    expect(proofs.map((proof) => proof.number)).toEqual([1, 2, 3, 4, 5]);
    expect(proofById('recovery').judge).toBe(judgeRecovery);
    expect(proofById('out-of-order').judge).toBe(judgeReference);
    const recovery = proofById('recovery');
    const outOfOrder = proofById('out-of-order');
    if (recovery.kind !== 'scenario' || outOfOrder.kind !== 'scenario') throw new Error('kind');
    expect(recovery.tickets.map((ticket) => ticket.kind)).toEqual(['REFUND', 'BET']);
    expect(recovery.followMs).toBeGreaterThan(outOfOrder.followMs);
    expect(proofById('reconcile').requires).toBe('operator');
  });
  test('views from links are validated before use', () => {
    expect(isViewId('ledger')).toBe(true);
    expect(isViewId('race')).toBe(true);
    expect(isViewId('drop table')).toBe(false);
    expect(isViewId(null)).toBe(false);
  });
});

describe('console roles', () => {
  test('follow the realm composition viewer < operator < demo-operator', () => {
    expect(can('demo-operator', 'operator')).toBe(true);
    expect(can('operator', 'operator')).toBe(true);
    expect(can('operator', 'demo-operator')).toBe(false);
    expect(can('viewer', 'operator')).toBe(false);
  });
});
