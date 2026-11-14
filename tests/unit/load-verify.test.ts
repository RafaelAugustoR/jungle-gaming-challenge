import { describe, expect, test } from 'bun:test';
import { buildPlan } from '../load/plan';
import type { RequestRecord } from '../load/stats';
import { duplicateFirstEffects, resolveFinalStates } from '../load/verify';

const plan = buildPlan({
  scenario: 'duplicates',
  seed: 3,
  operations: 60,
  wallets: 3,
  openingCents: 1_000_00n,
  oversizedRatio: 0,
  duplicateRatio: 0.5,
  duplicateWindow: 5,
});
const duplicate = plan.operations.find((op) => op.duplicateOf !== undefined)!;
const originalOf = duplicate.duplicateOf!;
const record = (index: number, overrides: Partial<RequestRecord>): RequestRecord => ({
  index,
  instance: 0,
  phase: 'measure',
  scheduledMs: index,
  outcome: 'not_issued',
  ...overrides,
});

describe('final state resolution', () => {
  test('uses definitive replays, skips never-sent operations and reads back only uncertain ones', async () => {
    const uncertain = plan.operations.find(
      (op) => op.duplicateOf === undefined && op.index !== originalOf,
    )!;
    const records = [
      // Original timed out, its duplicate came back as a definitive replay.
      record(originalOf, { outcome: 'error' }),
      record(duplicate.index, { outcome: 'replay', state: 'REJECTED' }),
      record(uncertain.index, { outcome: 'error' }),
    ];
    const readBacks: string[] = [];
    const resolution = await resolveFinalStates(plan, records, async (op) => {
      readBacks.push(op.externalTransactionId);
      return 'PROCESSED';
    });
    expect(resolution.states.get(originalOf)).toBe('REJECTED');
    expect(resolution.states.get(uncertain.index)).toBe('PROCESSED');
    expect(readBacks).toEqual([uncertain.externalTransactionId]);
    const originals = plan.operations.filter((op) => op.duplicateOf === undefined).length;
    expect(resolution.states.size).toBe(originals);
    expect(resolution.neverSent).toBe(originals - 2);
    expect(resolution.readBack).toBe(1);
  });

  test('propagates read-back failures instead of guessing a state', async () => {
    const records = [record(0, { outcome: 'error' })];
    await expect(
      resolveFinalStates(plan, records, async () => {
        throw new Error('HTTP 401');
      }),
    ).rejects.toThrow('HTTP 401');
  });
});

describe('duplicate financial effects', () => {
  test('counts operations whose copies produced more than one first submission result', () => {
    const clean = [
      record(originalOf, { outcome: 'processed', state: 'PROCESSED' }),
      record(duplicate.index, { outcome: 'replay', state: 'PROCESSED' }),
    ];
    expect(duplicateFirstEffects(plan, clean)).toBe(0);
    const doubled = [
      record(originalOf, { outcome: 'processed', state: 'PROCESSED' }),
      record(duplicate.index, { outcome: 'processed', state: 'PROCESSED' }),
    ];
    expect(duplicateFirstEffects(plan, doubled)).toBe(1);
  });
});
