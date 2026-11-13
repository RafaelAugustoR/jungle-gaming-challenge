import type { AppConfig } from '../../src/config/config';

interface Signal {
  stage: string;
  eventId?: string;
  token?: string;
  pid: number;
}
export function publisherWorker(config: AppConfig, queue: string, pause?: 'reserved' | 'sent') {
  const seen: Signal[] = [];
  const child = Bun.spawn(
    [process.execPath, new URL('outbox-process.ts', import.meta.url).pathname],
    {
      env: {
        ...process.env,
        DATABASE_URL: config.databaseUrl,
        SQS_ENDPOINT: config.sqsEndpoint,
        OUTBOX_TEST_QUEUE: queue,
        OUTBOX_TEST_BATCH: '1',
        OUTBOX_TEST_LEASE: pause === 'reserved' ? '5000' : '1000',
        OUTBOX_TEST_PAUSE: pause ?? '',
        OUTBOX_TEST_BARRIER: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
      ipc(message: Signal) {
        seen.push(message);
      },
    },
  );
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    pid: child.pid,
    signals: seen,
    async wait(stage: string) {
      const deadline = Date.now() + 10000;
      while (!seen.some((signal) => signal.stage === stage)) {
        if (child.exitCode !== null || Date.now() >= deadline) {
          child.kill('SIGKILL');
          const logs = await output;
          throw new Error(`Publisher ${child.pid} missing ${stage}: ${logs.join('\n')}`);
        }
        await Bun.sleep(10);
      }
      return seen.find((signal) => signal.stage === stage)!;
    },
    release() {
      child.send('release');
    },
    async exit() {
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {
        return { code: await child.exited, logs: await output };
      } finally {
        clearTimeout(timeout);
      }
    },
    async kill() {
      child.kill('SIGKILL');
      await child.exited;
      await output;
    },
  };
}
