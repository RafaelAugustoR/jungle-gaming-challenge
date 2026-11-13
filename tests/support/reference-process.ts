import { resolve } from 'node:path';
import type { AppConfig } from '../../src/config/config';

export async function referenceProcess(config: AppConfig) {
  let signalReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, '../../src/bootstrap/reference-worker.ts')],
    {
      env: {
        ...process.env,
        DATABASE_URL: config.databaseUrl,
        REFERENCE_POLL_MS: '25',
        REFERENCE_BATCH_SIZE: '50',
      },
      stdout: 'ignore',
      stderr: 'inherit',
      ipc(message: { ready?: boolean }) {
        if (message.ready) signalReady();
      },
    },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      child.exited.then((code) => {
        throw new Error(`Reference worker exited before ready: ${code}`);
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Reference worker readiness timeout')), 10000);
      }),
    ]);
    return {
      pid: child.pid,
      stop: async () => {
        child.send('stop');
        await child.exited;
      },
      kill: async () => {
        child.kill('SIGKILL');
        await child.exited;
      },
    };
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
