import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../config/config';
import { openDatabase } from '../config/orm';
import { createSqsClient } from '../config/sqs';
import { loadOutboxConfig } from './outbox/config';
import { JsonLogger } from '../observability/logger';

export async function runMessagingWorker(kind: 'publisher' | 'consumer') {
  const config = loadConfig(),
    options = loadOutboxConfig();
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
    const queueUrl = (
      await sqs.send(new GetQueueUrlCommand({ QueueName: options.queueName }), {
        abortSignal: AbortSignal.timeout(options.sendTimeoutMs),
      })
    ).QueueUrl;
    if (!queueUrl) throw new Error('EVENT_QUEUE_NOT_FOUND');
    const { OutboxPublisher } = await import('./outbox/outbox-publisher');
    const { OutboxRepository } = await import('./outbox/outbox-repository');
    const { EventConsumer } = await import('./events/event-consumer');
    const runner =
      kind === 'publisher'
        ? new OutboxPublisher(new OutboxRepository(orm), sqs, { ...options, queueUrl })
        : new EventConsumer(orm, sqs, queueUrl);
    logger.log({ event: 'worker_started', worker: kind });
    do {
      try {
        await runner.runOnce();
      } catch (error) {
        logger.error({ event: 'worker_iteration_failed', worker: kind, error });
        if (process.argv.includes('--once')) throw error;
      }
      if (stopping || process.argv.includes('--once')) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.pollMs);
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
    logger.log({ event: 'worker_stopped', worker: kind });
  }
}
