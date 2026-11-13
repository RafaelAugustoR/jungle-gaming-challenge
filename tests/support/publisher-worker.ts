import type { AppConfig } from '../../src/config/config';
import { spawnStaged } from './spawn-staged';
export function publisherWorker(
  config: AppConfig,
  queue: string,
  options: { pause?: 'reserved' | 'sent'; leaseMs?: number } = {},
) {
  const worker = spawnStaged(new URL('outbox-process.ts', import.meta.url).pathname, {
    DATABASE_URL: config.databaseUrl,
    SQS_ENDPOINT: config.sqsEndpoint,
    OUTBOX_TEST_QUEUE: queue,
    OUTBOX_TEST_BATCH: '1',
    OUTBOX_TEST_LEASE: String(options.leaseMs ?? 1000),
    OUTBOX_TEST_PAUSE: options.pause ?? '',
  });
  return { ...worker, kill: () => worker.stop('SIGKILL') };
}
