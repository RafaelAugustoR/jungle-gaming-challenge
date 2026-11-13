import 'reflect-metadata';
import { loadConfig } from '../../src/config/config';
import { openDatabase } from '../../src/config/orm';
import { createSqsClient } from '../../src/config/sqs';
import { CommandConsumer } from '../../src/messaging/commands/command-consumer';
const config = loadConfig(),
  orm = await openDatabase(config),
  sqs = createSqsClient(config);
let paused = false;
const pause = async (stage: string, messageId: string) => {
  process.send?.({ stage, messageId, pid: process.pid });
  if (!paused && process.env.COMMAND_TEST_PAUSE === stage) {
    paused = true;
    await new Promise<void>((resolve) => process.once('message', () => resolve()));
  }
};
const runner = new CommandConsumer(
  orm,
  sqs,
  config,
  {
    queueUrl: process.env.COMMAND_TEST_QUEUE!,
    dlqUrl: process.env.COMMAND_TEST_DLQ!,
    visibilitySeconds: Number(process.env.COMMAND_TEST_VISIBILITY ?? 1),
    callTimeoutMs: 1000,
    waitSeconds: 0,
    retryBaseMs: 1,
    retryMaxMs: 1,
    drainMs: Number(process.env.COMMAND_TEST_DRAIN ?? 100),
  },
  {
    committed: (id) => pause('committed', id),
    deadLetterSent: (id) => pause('deadLetterSent', id),
  },
);
let stopping = false;
const stop = () => {
  stopping = true;
  runner.stop();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
try {
  process.send?.({ stage: 'ready', pid: process.pid });
  do {
    await runner.runOnce();
    if (!stopping) await Bun.sleep(10);
  } while (!stopping);
} finally {
  sqs.destroy();
  await orm.close(true);
  process.disconnect?.();
}
