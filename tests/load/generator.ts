import type { Outcome, RequestRecord } from './stats';

/** Transport-agnostic result an adapter returns for one submission. */
export type SendResult = (
  | { outcome: 'definitive'; state: 'PROCESSED' | 'REJECTED'; replay: boolean }
  | { outcome: 'pending' | 'conflict' | 'error' }
) & { httpStatus?: number; code?: string };

export interface OpenLoopOptions {
  total: number;
  ratePerSecond: number;
  /** The first operations warm caches and connections and are excluded from the statistics. */
  warmupCount: number;
  /** Generator concurrency cap; operations due while it is reached are recorded as not issued. */
  maxInFlight: number;
  instances: number;
  send: (index: number, instance: number) => Promise<SendResult>;
  onScheduleComplete?: () => void;
}

function outcomeOf(result: SendResult): Outcome {
  if (result.outcome !== 'definitive') return result.outcome;
  if (result.replay) return 'replay';
  return result.state === 'PROCESSED' ? 'processed' : 'rejected';
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
    // Yield even when overdue so completions can release in-flight capacity.
    await Bun.sleep(wait > 1 ? wait : 0);
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
        (result) => {
          record.outcome = outcomeOf(result);
          if (result.outcome === 'definitive') record.state = result.state;
          if (result.httpStatus !== undefined) record.httpStatus = result.httpStatus;
          if (result.code !== undefined) record.code = result.code;
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
