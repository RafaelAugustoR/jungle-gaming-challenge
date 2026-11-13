import type { AppConfig } from '../../src/config/config';
import { spawnStaged } from './spawn-staged';
export function commandWorker(
  config: AppConfig,
  queue: string,
  dlq: string,
  extra: Record<string, string> = {},
) {
  return spawnStaged(new URL('command-process.ts', import.meta.url).pathname, {
    DATABASE_URL: config.databaseUrl,
    SQS_ENDPOINT: config.sqsEndpoint,
    COMMAND_TEST_QUEUE: queue,
    COMMAND_TEST_DLQ: dlq,
    ...extra,
  });
}
