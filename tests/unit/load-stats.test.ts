import { describe, expect, test } from 'bun:test';
import { classifyResponse, type Outcome } from '../load/classify';
import { percentile, summarize, type RequestRecord } from '../load/stats';
import { parsePrometheus, sumMetric } from '../load/prometheus';

describe('response classification', () => {
  test('separates business results, replays and technical errors', () => {
    const cases: [number, unknown, Outcome][] = [
      [200, { status: 'PROCESSED', idempotentReplay: false }, 'processed'],
      [200, { status: 'PROCESSED', idempotentReplay: true }, 'replay'],
      [422, { failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: true }, 'replay'],
      [422, { failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: false }, 'rejected'],
      [202, { status: 'PENDING_REFERENCE', idempotentReplay: false }, 'pending'],
      [409, { code: 'IDEMPOTENCY_CONFLICT' }, 'conflict'],
      [503, { code: 'INFRASTRUCTURE_UNAVAILABLE' }, 'error'],
      [500, {}, 'error'],
      [401, {}, 'error'],
      [200, 'not json', 'error'],
    ];
    for (const [status, body, outcome] of cases)
      expect(classifyResponse(status, body)).toBe(outcome);
  });
});

describe('latency statistics', () => {
  test('percentile uses nearest rank and handles empty inputs', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  test('summary excludes warmup and keeps rejections, replays and errors apart', () => {
    const record = (overrides: Partial<RequestRecord>): RequestRecord => ({
      index: 0,
      instance: 0,
      phase: 'measure',
      scheduledMs: 0,
      sentMs: 0,
      completedMs: 10,
      latencyMs: 10,
      outcome: 'processed',
      ...overrides,
    });
    const summary = summarize(
      [
        record({ phase: 'warmup', latencyMs: 9999, outcome: 'error' }),
        record({ index: 1, latencyMs: 10, completedMs: 500 }),
        record({ index: 2, instance: 1, latencyMs: 20, outcome: 'rejected', completedMs: 900 }),
        record({ index: 3, latencyMs: 30, outcome: 'replay', completedMs: 1000 }),
        record({ index: 4, instance: 1, latencyMs: 40, outcome: 'error', completedMs: 1200 }),
        record({
          index: 5,
          outcome: 'not_issued',
          sentMs: undefined,
          completedMs: undefined,
          latencyMs: undefined,
        }),
      ],
      { windowStartMs: 0, windowEndMs: 1000, instances: 2 },
    );
    expect(summary.scheduled).toBe(5);
    expect(summary.issued).toBe(4);
    expect(summary.notIssued).toBe(1);
    expect(summary.outcomes).toMatchObject({ processed: 1, rejected: 1, replay: 1, error: 1 });
    expect(summary.offeredRps).toBe(5);
    expect(summary.completedRps).toBeCloseTo(4 / 1.2);
    expect(summary.financialRps).toBeCloseTo(2 / 1.2);
    expect(summary.errorRate).toBeCloseTo(1 / 4);
    expect(summary.latencyMs).toMatchObject({ p50: 20, p95: 40, p99: 40, max: 40 });
    expect(summary.drainAfterWindowMs).toBe(200);
    expect(summary.perInstance).toEqual([
      { instance: 0, issued: 2, p95: 30 },
      { instance: 1, issued: 2, p95: 40 },
    ]);
  });
});

describe('prometheus parsing', () => {
  test('sums a metric across labels with an optional label filter', () => {
    const samples = parsePrometheus(
      [
        '# HELP wallet_lock_conflicts_total x',
        'wallet_lock_conflicts_total{source="financial"} 3',
        'jungle_retries_total{component="financial",reason="lock_timeout"} 2',
        'jungle_retries_total{component="outbox",reason="send"} 5',
        'jungle_retries_total{component="financial",reason="serialization_failure"} 1',
      ].join('\n'),
    );
    expect(sumMetric(samples, 'wallet_lock_conflicts_total')).toBe(3);
    expect(sumMetric(samples, 'jungle_retries_total', { component: 'financial' })).toBe(3);
    expect(sumMetric(samples, 'absent_metric')).toBe(0);
  });
});
