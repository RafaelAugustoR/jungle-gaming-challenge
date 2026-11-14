import { classifyResponse } from './classify';
import type { RequestRecord } from './stats';

export interface OpenLoopOptions {
  total: number;
  ratePerSecond: number;
  /** The first operations warm caches and connections and are excluded from the statistics. */
  warmupCount: number;
  /** Generator concurrency cap; operations due while it is reached are recorded as not issued. */
  maxInFlight: number;
  instances: number;
  send: (index: number, instance: number) => Promise<{ status: number; body: unknown }>;
  onScheduleComplete?: () => void;
}

/**
 * Open (arrival-rate) model: operation i is due at i / rate regardless of earlier responses,
 * so slow responses surface as latency, backlog or unissued requests instead of silently
 * lowering the offered rate (coordinated omission).
 */
export async function runOpenLoop(options: OpenLoopOptions) {
  const intervalMs = 1000 / options.ratePerSecond;
  const records: RequestRecord[] = [];
  const pending = new Set<Promise<void>>();
  const start = performance.now();
  const now = () => performance.now() - start;
  let inFlight = 0;
  for (let index = 0; index < options.total; index++) {
    const scheduledMs = index * intervalMs;
    const wait = scheduledMs - now();
    if (wait > 1) await Bun.sleep(wait);
    const instance = index % options.instances;
    const record: RequestRecord = {
      index,
      instance,
      phase: index < options.warmupCount ? 'warmup' : 'measure',
      scheduledMs,
      outcome: 'not_issued',
    };
    records.push(record);
    if (inFlight >= options.maxInFlight) continue;
    inFlight++;
    record.sentMs = now();
    const task = options
      .send(index, instance)
      .then(
        ({ status, body }) => {
          record.httpStatus = status;
          record.outcome = classifyResponse(status, body);
          const value = body as { failureCode?: unknown; code?: unknown } | null;
          const code = value?.failureCode ?? value?.code;
          if (typeof code === 'string') record.failureCode = code;
        },
        (error: unknown) => {
          record.outcome = 'error';
          record.error = error instanceof Error ? error.message : String(error);
        },
      )
      .finally(() => {
        record.completedMs = now();
        record.latencyMs = record.completedMs - record.sentMs!;
        inFlight--;
        pending.delete(task);
      });
    pending.add(task);
  }
  options.onScheduleComplete?.();
  await Promise.all(pending);
  return {
    records,
    windowStartMs: options.warmupCount * intervalMs,
    windowEndMs: options.total * intervalMs,
  };
}
