import type { AppConfig } from '../../src/config/config';
import { spawnStaged } from './spawn-staged';
export async function referenceProcess(config: AppConfig) {
  const worker = spawnStaged(
    new URL('../../src/bootstrap/reference-worker.ts', import.meta.url).pathname,
    {
      DATABASE_URL: config.databaseUrl,
      REFERENCE_POLL_MS: '25',
      REFERENCE_BATCH_SIZE: '50',
    },
  );
  try {
    await worker.wait('ready');
    return {
      pid: worker.pid,
      async stop() {
        if (worker.child.exitCode === null) worker.release('stop');
        await worker.exit(5000);
      },
      kill: () => worker.stop('SIGKILL'),
    };
  } catch (error) {
    await worker.stop('SIGKILL');
    throw error;
  }
}
