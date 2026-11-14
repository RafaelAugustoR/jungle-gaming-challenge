import { setTimeout as delay } from 'node:timers/promises';
import { WorkerBackoff } from './worker-backoff';

export interface LoopRunner {
  runOnce(): Promise<number>;
}
export interface WorkerLoopOptions {
  once: boolean;
  pollMs: number;
  signal: AbortSignal;
  /**
   * When true for an iteration's processed count, the next iteration starts immediately instead
   * of waiting pollMs. Defaults to always waiting, so workers opt in explicitly.
   */
  continueWhen?: (processed: number) => boolean;
  onError: (error: unknown) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  delay(ms, undefined, { signal }).catch(() => undefined);

/** Polling loop shared by workers; failures always wait (backoff or at least 1 s), never spin. */
export async function workerLoop(runner: LoopRunner, options: WorkerLoopOptions) {
  const sleep = options.sleep ?? abortableSleep;
  while (!options.signal.aborted) {
    let delayMs = options.pollMs;
    try {
      const processed = await runner.runOnce();
      if (options.continueWhen?.(processed)) delayMs = 0;
    } catch (error) {
      options.onError(error);
      if (options.once) throw error;
      delayMs = error instanceof WorkerBackoff ? error.delayMs : Math.max(1000, delayMs);
    }
    if (options.signal.aborted || options.once) break;
    if (delayMs > 0) await sleep(delayMs, options.signal);
  }
}
