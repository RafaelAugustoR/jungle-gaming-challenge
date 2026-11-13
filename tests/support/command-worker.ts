import type { AppConfig } from '../../src/config/config';
export function commandWorker(
  config: AppConfig,
  queue: string,
  dlq: string,
  extra: Record<string, string> = {},
) {
  const seen: { stage: string; messageId?: string; pid: number }[] = [];
  let changed: (() => void) | undefined;
  const child = Bun.spawn(
    [process.execPath, new URL('command-process.ts', import.meta.url).pathname],
    {
      env: {
        ...process.env,
        DATABASE_URL: config.databaseUrl,
        SQS_ENDPOINT: config.sqsEndpoint,
        COMMAND_TEST_QUEUE: queue,
        COMMAND_TEST_DLQ: dlq,
        ...extra,
      },
      stdout: 'pipe',
      stderr: 'inherit',
      ipc(message: { stage: string; messageId?: string; pid: number }) {
        seen.push(message);
        changed?.();
      },
    },
  );
  const logs = new Response(child.stdout).text();
  return {
    child,
    logs,
    async wait(stage: string, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (!seen.some((message) => message.stage === stage)) {
        if (Date.now() >= deadline) throw new Error(`Worker ${child.pid}: missing ${stage}`);
        await Promise.race([
          new Promise<void>((resolve) => {
            changed = resolve;
            setTimeout(resolve, 25);
          }),
          child.exited.then((code) => {
            throw new Error(`Worker exited ${code} before ${stage}`);
          }),
        ]);
      }
      return seen.find((message) => message.stage === stage)!;
    },
    async stop(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
      child.kill(signal);
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        return await child.exited;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
