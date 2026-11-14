import { describe, expect, test } from 'bun:test';
import {
  buildPlan,
  centsToAmount,
  expectedBalances,
  OVERSIZED_BET,
  type PlanOptions,
} from '../load/plan';

const base: PlanOptions = {
  scenario: 'distributed',
  seed: 42,
  operations: 400,
  wallets: 10,
  openingCents: 100_000_00n,
  oversizedRatio: 0.05,
  duplicateRatio: 0.3,
  duplicateWindow: 20,
};

describe('load plan', () => {
  test('the same seed reproduces an identical plan and another seed changes it', () => {
    expect(buildPlan(base)).toEqual(buildPlan(base));
    expect(buildPlan({ ...base, seed: 43 }).operations).not.toEqual(buildPlan(base).operations);
  });

  test('hot-wallet scenario targets exactly one wallet', () => {
    const plan = buildPlan({ ...base, scenario: 'hot-wallet', wallets: 50 });
    expect(plan.wallets).toBe(1);
    expect(new Set(plan.operations.map((op) => op.walletIndex))).toEqual(new Set([0]));
  });

  test('distributed scenario spreads operations across every wallet without duplicates', () => {
    const plan = buildPlan(base);
    expect(new Set(plan.operations.map((op) => op.walletIndex)).size).toBe(10);
    expect(plan.operations.every((op) => op.duplicateOf === undefined)).toBe(true);
    expect(new Set(plan.operations.map((op) => op.idempotencyKey)).size).toBe(400);
  });

  test('duplicates replay an earlier original with identical key and business content', () => {
    const plan = buildPlan({ ...base, scenario: 'duplicates' });
    const duplicates = plan.operations.filter((op) => op.duplicateOf !== undefined);
    expect(duplicates.length).toBeGreaterThan(80);
    expect(duplicates.length).toBeLessThan(160);
    for (const duplicate of duplicates) {
      const original = plan.operations[duplicate.duplicateOf!]!;
      expect(original.duplicateOf).toBeUndefined();
      expect(duplicate.duplicateOf!).toBeLessThan(duplicate.index);
      expect(duplicate.index - duplicate.duplicateOf!).toBeLessThanOrEqual(
        base.duplicateWindow * 4,
      );
      const { index: _a, duplicateOf: _b, ...copy } = duplicate;
      const { index: _c, duplicateOf: _d, ...source } = original;
      expect(copy).toEqual(source);
    }
  });

  test('operations use canonical two-decimal amounts and oversized bets are deliberate', () => {
    const plan = buildPlan(base);
    for (const op of plan.operations) {
      expect(op.amount).toMatch(/^(0|[1-9]\d*)\.\d{2}$/);
      expect(['BET', 'WIN']).toContain(op.kind);
    }
    const oversized = plan.operations.filter((op) => op.amount === OVERSIZED_BET);
    expect(oversized.every((op) => op.kind === 'BET' && op.oversized)).toBe(true);
    expect(oversized.length).toBeGreaterThan(5);
    expect(oversized.length).toBeLessThan(45);
  });

  test('cents format exactly without floating point rounding', () => {
    expect(centsToAmount(0n)).toBe('0.00');
    expect(centsToAmount(5n)).toBe('0.05');
    expect(centsToAmount(123456n)).toBe('1234.56');
    expect(centsToAmount(-250n)).toBe('-2.50');
  });

  test('expected balances apply only processed unique operations', () => {
    const plan = buildPlan({ ...base, scenario: 'hot-wallet', operations: 3, oversizedRatio: 0 });
    const outcomes = new Map<number, 'PROCESSED' | 'REJECTED' | 'NOT_APPLIED'>([
      [0, 'PROCESSED'],
      [1, 'REJECTED'],
      [2, 'NOT_APPLIED'],
    ]);
    const [op] = plan.operations;
    const delta = BigInt(op!.amount.replace('.', '')) * (op!.kind === 'BET' ? -1n : 1n);
    expect(expectedBalances(plan, outcomes)).toEqual([base.openingCents + delta]);
  });
});
