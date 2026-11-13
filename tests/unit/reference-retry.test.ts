import { expect, test } from 'bun:test';
import { ReferenceRetryPolicy } from '../../src/modules/wagering/domain/reference-retry';

test('reference retry uses bounded exponential jitter and preserves the acceptance deadline', () => {
  const policy = new ReferenceRetryPolicy({ ttlMs: 900000, baseMs: 1000, maxMs: 30000 }, () => 0);
  const accepted = new Date('2026-11-13T00:00:00.000Z');
  expect(policy.deadline(accepted).toISOString()).toBe('2026-11-13T00:15:00.000Z');
  expect(policy.next(accepted, 0, policy.deadline(accepted)).toISOString()).toBe(
    '2026-11-13T00:00:00.500Z',
  );
  expect(policy.next(accepted, 30, policy.deadline(accepted)).toISOString()).toBe(
    '2026-11-13T00:00:15.000Z',
  );
  expect(
    policy.next(new Date('2026-11-13T00:14:59.900Z'), 30, policy.deadline(accepted)).toISOString(),
  ).toBe('2026-11-13T00:15:00.000Z');
});
