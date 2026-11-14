import { describe, expect, test } from 'bun:test';
import { WorkerBackoff } from '../../src/messaging/worker-backoff';
import { workerLoop } from '../../src/messaging/worker-loop';

/** Scripted runner: each step returns a processed count or throws; aborts when exhausted. */
function scripted(steps: (number | Error)[], shutdown: AbortController) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async runOnce() {
      const step = steps[calls++];
      if (calls >= steps.length) shutdown.abort();
      if (step instanceof Error) throw step;
      return step ?? 0;
    },
  };
}

async function run(
  steps: (number | Error)[],
  options: { continueWhen?: (processed: number) => boolean; once?: boolean } = {},
) {
  const shutdown = new AbortController();
  const runner = scripted(steps, shutdown);
  const sleeps: number[] = [];
  const errors: unknown[] = [];
  await workerLoop(runner, {
    once: options.once ?? false,
    pollMs: 500,
    signal: shutdown.signal,
    continueWhen: options.continueWhen,
    onError: (error) => errors.push(error),
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { calls: runner.calls, sleeps, errors };
}

describe('worker loop', () => {
  test('sleeps the poll interval after every iteration by default', async () => {
    expect((await run([20, 20, 0, 0])).sleeps).toEqual([500, 500, 500]);
  });

  test('continues without sleeping while the runner reports more work', async () => {
    const result = await run([20, 1, 1, 0, 3, 0], { continueWhen: (processed) => processed > 0 });
    expect(result.calls).toBe(6);
    expect(result.sleeps).toEqual([500]);
  });

  test('failures still back off instead of spinning', async () => {
    const result = await run([5, new WorkerBackoff(2000), new Error('db down'), 0], {
      continueWhen: (processed) => processed > 0,
    });
    expect(result.sleeps).toEqual([2000, 1000]);
    expect(result.errors).toHaveLength(2);
  });

  test('once runs a single iteration and rethrows its failure', async () => {
    expect((await run([20, 20], { once: true, continueWhen: () => true })).calls).toBe(1);
    await expect(run([new Error('boom')], { once: true })).rejects.toThrow('boom');
  });
});
