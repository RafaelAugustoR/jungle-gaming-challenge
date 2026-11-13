import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { WorkerBackoff } from './worker-backoff';
import { loadConfig } from '../config/config';
import { openDatabase } from '../config/orm';
import { createSqsClient } from '../config/sqs';
import { JsonLogger } from '../observability/logger';

export async function runWorker(
  name: string,
  create: (deps: { orm: MikroORM; sqs: SQSClient }) => Promise<{ runOnce(): Promise<number> }>,
  options: { once: boolean; pollMs: number },
) {
  const config = loadConfig();
  const orm = await openDatabase(config),
    sqs = createSqsClient(config);
  const logger = new JsonLogger();
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const runner = await create({ orm, sqs });
    logger.log({ event: 'worker_started', worker: name });
    do {
      let delayMs = options.pollMs;
      try {
        await runner.runOnce();
      } catch (error) {
        logger.error({ event: 'worker_iteration_failed', worker: name, error });
        if (options.once) throw error;
        if (error instanceof WorkerBackoff) delayMs = error.delayMs;
      }
      if (stopping || options.once) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    } while (!stopping);
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    sqs.destroy();
    await orm.close(true);
    logger.log({ event: 'worker_stopped', worker: name });
  }
}
