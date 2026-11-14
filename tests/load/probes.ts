import { sumMetric, type Sample } from './prometheus';
import { latency } from './stats';

type Sql = (query: string) => Promise<any[]>;
export interface DatabaseSample {
  atMs: number;
  lockWaits: number;
  active: number;
  oldestLockWaitMs: number | null;
  outboxPending: number;
  outboxOldestAgeMs: number | null;
}
const roundOrNull = (value: unknown) => (value === null ? null : Math.round(Number(value)));

/** The only outbox query: used by the sampler during load and by the drain afterwards. */
export async function outboxState(sql: Sql) {
  const [row] = await sql(`select
      count(*)::int total,
      count(*) filter (where published_at is null)::int pending,
      extract(epoch from clock_timestamp()-min(occurred_at) filter (where published_at is null))*1000 oldest_age_ms
    from wagering.outbox`);
  return {
    total: row.total as number,
    pending: row.pending as number,
    oldestAgeMs: roundOrNull(row.oldest_age_ms),
  };
}

async function lockState(sql: Sql) {
  const [row] = await sql(`select
      count(*) filter (where wait_event_type='Lock')::int lock_waits,
      count(*) filter (where state='active' and pid<>pg_backend_pid())::int active,
      extract(epoch from max(clock_timestamp()-query_start) filter (where wait_event_type='Lock'))*1000 oldest_lock_wait_ms
    from pg_stat_activity where datname=current_database()`);
  return {
    lockWaits: row.lock_waits as number,
    active: row.active as number,
    oldestLockWaitMs: roundOrNull(row.oldest_lock_wait_ms),
  };
}

/** Samples locks and outbox backlog until stopped; a failed sample is a gap, not a failure. */
export function startSampler(sql: Sql, intervalMs: number) {
  const samples: DatabaseSample[] = [];
  const start = performance.now();
  let running = true;
  const loop = (async () => {
    while (running) {
      const sample = await Promise.all([lockState(sql), outboxState(sql)]).catch(() => undefined);
      if (sample) {
        const [locks, outbox] = sample;
        samples.push({
          atMs: performance.now() - start,
          ...locks,
          outboxPending: outbox.pending,
          outboxOldestAgeMs: outbox.oldestAgeMs,
        });
      }
      await Bun.sleep(intervalMs);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return samples;
    },
  };
}

/** Publication is measured after the load: financial responses never wait for the outbox. */
export async function drainOutbox(sql: Sql, timeoutMs: number) {
  const atLoadEnd = await outboxState(sql);
  const start = performance.now();
  let current = atLoadEnd;
  let drainedAfterMs: number | null = current.pending === 0 ? 0 : null;
  while (drainedAfterMs === null && performance.now() - start < timeoutMs) {
    await Bun.sleep(100);
    current = await outboxState(sql);
    if (current.pending === 0) drainedAfterMs = Math.round(performance.now() - start);
  }
  const seconds = (performance.now() - start) / 1000;
  return {
    eventsAtLoadEnd: atLoadEnd.total,
    pendingAtLoadEnd: atLoadEnd.pending,
    drainedAfterMs,
    timeoutMs,
    pendingWhenStopped: current.pending,
    publishedPerSecondWhileDraining:
      timeoutMs > 0 && seconds > 0
        ? Math.round(((atLoadEnd.pending - current.pending) / seconds) * 10) / 10
        : null,
  };
}

export function summarizeSamples(
  samples: DatabaseSample[],
  windowStartMs: number,
  windowEndMs: number,
  loadEndMs: number,
) {
  const window = samples.filter((s) => s.atMs >= windowStartMs && s.atMs <= windowEndMs);
  const mean = (values: number[]) =>
    values.length
      ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100
      : null;
  const values = (pick: (s: DatabaseSample) => number | null) =>
    window.map(pick).filter((v): v is number => v !== null);
  return {
    samplesInWindow: window.length,
    lockWaitingBackends: {
      mean: mean(values((s) => s.lockWaits)),
      ...latency(values((s) => s.lockWaits)),
    },
    oldestLockWaitMs: latency(values((s) => s.oldestLockWaitMs)),
    activeBackends: { mean: mean(values((s) => s.active)), ...latency(values((s) => s.active)) },
    outboxPending: latency(values((s) => s.outboxPending)),
    outboxOldestAgeMs: latency(values((s) => s.outboxOldestAgeMs)),
    loadEndMs: Math.round(loadEndMs),
  };
}

/** Per-process counters reset with each API; only before/after deltas are meaningful. */
export function processMetricDeltas(before: Sample[][], after: Sample[][]) {
  const delta = (name: string, filter: Record<string, string> = {}) =>
    after.reduce(
      (total, samples, i) =>
        total + sumMetric(samples, name, filter) - sumMetric(before[i]!, name, filter),
      0,
    );
  return {
    walletLockConflicts: delta('wallet_lock_conflicts_total'),
    financialRetries: delta('jungle_retries_total', { component: 'financial' }),
  };
}
