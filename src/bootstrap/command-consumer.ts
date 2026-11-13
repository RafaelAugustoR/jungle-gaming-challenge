import 'reflect-metadata';
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../config/config';
import { openDatabase } from '../config/orm';
import { createSqsClient } from '../config/sqs';
import { CommandConsumer } from '../messaging/commands/command-consumer';
import { loadCommandConfig } from '../messaging/commands/config';
import { JsonLogger } from '../observability/logger';
async function main() {
  const config = loadConfig(),
    command = loadCommandConfig(),
    logger = new JsonLogger();
  const orm = await openDatabase(config),
    sqs = createSqsClient(config),
    shutdown = new AbortController();
  let runner: CommandConsumer | undefined;
  const stop = () => {
    shutdown.abort();
    runner?.stop();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const find = async (name: string) => {
      const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }), {
        abortSignal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(command.callTimeoutMs)]),
      });
      if (!QueueUrl) throw new Error('COMMAND_QUEUE_NOT_FOUND');
      return QueueUrl;
    };
    const queueUrl = await find(command.queueName),
      dlqUrl = await find(command.queueName.replace(/\.fifo$/, '-dlq.fifo'));
    runner = new CommandConsumer(orm, sqs, config, { ...command, queueUrl, dlqUrl });
    logger.log({ event: 'command_worker_started', pid: process.pid });
    process.send?.({ ready: true, pid: process.pid });
    while (!shutdown.signal.aborted) {
      try {
        await runner.runOnce();
      } catch (error) {
        logger.error({ event: 'command_poll_failed', error });
        if (process.argv.includes('--once')) throw error;
        await delay(1000, undefined, { signal: shutdown.signal }).catch(() => undefined);
      }
      if (process.argv.includes('--once')) break;
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    sqs.destroy();
    await orm.close(true);
    logger.log({ event: 'command_worker_stopped', pid: process.pid });
    if (process.connected) process.disconnect?.();
  }
}
main().catch((error) => {
  new JsonLogger().error(error);
  process.exitCode = 1;
});
