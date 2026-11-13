import { expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MetricsRegistry } from '../../src/observability/metrics.module';

test('Prometheus scrape singleflights bounded DB snapshots and separates durable totals from attempts', async () => {
  let queries = 0;
  const rows = [
    { metric: 'transaction', operation: 'BET', status: 'PROCESSED', value: '3', age: null, blocked: null },
    { metric: 'transaction', operation: 'WIN', status: 'PENDING_REFERENCE', value: '2', age: null, blocked: null },
    { metric: 'outbox', operation: null, status: null, value: '4', age: '12.5', blocked: '1' },
    { metric: 'references', operation: null, status: null, value: '6', age: null, blocked: null },
  ];
  const orm = {
    em: {
      fork: () => ({ transactional: async (work: (em: unknown) => Promise<unknown>) => work({
        execute: async (sql: string) => {
          if (sql.startsWith('set local')) return [];
          queries++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return rows;
        },
      }) }),
    },
  } as unknown as MikroORM;
  const metrics = new MetricsRegistry(orm);
  metrics.transactionAttempts.inc({ operation: 'BET', channel: 'http', status: 'PROCESSED' }, 8);
  metrics.transactionDuplicates.inc({ operation: 'BET', channel: 'http' }, 5);

  const [scrape] = await Promise.all([metrics.scrape(), metrics.scrape()]);

  expect(scrape).toContain('wager_transactions{operation="BET",status="PROCESSED"} 3');
  expect(scrape).toContain('wager_transactions{operation="WIN",status="PENDING_REFERENCE"} 2');
  expect(scrape).toContain('wager_transaction_attempts_total{operation="BET",channel="http",status="PROCESSED"} 8');
  expect(scrape).toContain('wager_transaction_duplicates_total{operation="BET",channel="http"} 5');
  expect(scrape).toContain('outbox_pending_events 4');
  expect(scrape).toContain('outbox_blocked_events 1');
  expect(scrape).toContain('outbox_oldest_pending_age_seconds 12.5');
  expect(scrape).toContain('reference_retry_attempts 6');
  await metrics.scrape();
  expect(queries).toBe(1);
});

test('a timed out durable snapshot is not cached and the next scrape retries it', async () => {
  let calls = 0;
  const orm = {
    em: { fork: () => ({ transactional: async () => { calls++; throw new Error('statement timeout'); } }) },
  } as unknown as MikroORM;
  const metrics = new MetricsRegistry(orm);
  await expect(metrics.scrape()).rejects.toThrow('statement timeout');
  await expect(metrics.scrape()).rejects.toThrow('statement timeout');
  expect(calls).toBe(2);
});
