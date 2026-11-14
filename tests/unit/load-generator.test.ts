import { expect, test } from 'bun:test';
import { runOpenLoop } from '../load/generator';

test('open loop keeps the offered schedule and records requests it cannot issue', async () => {
  const release: (() => void)[] = [];
  const result = await runOpenLoop({
    total: 6,
    ratePerSecond: 200,
    warmupCount: 2,
    maxInFlight: 2,
    instances: 3,
    send: (index) =>
      new Promise((resolve) => {
        // The first two requests stay in flight, saturating the generator's concurrency cap.
        if (index < 2) release.push(() => resolve({ status: 200, body: { status: 'PROCESSED' } }));
        else resolve({ status: 200, body: { status: 'PROCESSED', idempotentReplay: false } });
      }),
    onScheduleComplete: () => release.forEach((done) => done()),
  });
  expect(result.records.map((r) => r.instance)).toEqual([0, 1, 2, 0, 1, 2]);
  expect(result.records.map((r) => r.phase)).toEqual([
    'warmup',
    'warmup',
    'measure',
    'measure',
    'measure',
    'measure',
  ]);
  expect(result.records.slice(2).every((r) => r.outcome === 'not_issued')).toBe(true);
  expect(result.records.slice(0, 2).every((r) => r.outcome === 'processed')).toBe(true);
  expect(result.windowEndMs - result.windowStartMs).toBeCloseTo(20, 0);
});

test('open loop turns thrown requests into technical errors without stopping the schedule', async () => {
  const result = await runOpenLoop({
    total: 3,
    ratePerSecond: 1000,
    warmupCount: 0,
    maxInFlight: 10,
    instances: 1,
    send: async (index) => {
      if (index === 1) throw new Error('socket hang up');
      return { status: 422, body: { failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: false } };
    },
  });
  expect(result.records.map((r) => r.outcome)).toEqual(['rejected', 'error', 'rejected']);
  expect(result.records[1]!.error).toBe('socket hang up');
  expect(result.records.every((r) => r.latencyMs !== undefined)).toBe(true);
});

test('open loop yields while behind schedule so completed requests free capacity', async () => {
  // At this rate every operation is already overdue; completions must still be observed.
  const result = await runOpenLoop({
    total: 50,
    ratePerSecond: 1_000_000,
    warmupCount: 0,
    maxInFlight: 1,
    instances: 1,
    send: async () => ({ status: 200, body: { status: 'PROCESSED', idempotentReplay: false } }),
  });
  expect(result.records.filter((r) => r.outcome === 'not_issued')).toHaveLength(0);
});
