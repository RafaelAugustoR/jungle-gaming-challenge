import 'reflect-metadata';
import { loadConfig } from '../../src/config/config';
import { loadCommandConfig } from '../../src/messaging/commands/config';
import { runCommandWorker } from '../../src/messaging/commands/run-command-worker';
let paused = false;
const pause = async (stage: string, messageId: string) => {
  process.send?.({ stage, messageId, pid: process.pid });
  if (!paused && process.env.COMMAND_TEST_PAUSE === stage) {
    paused = true;
    await new Promise<void>((resolve) => process.once('message', () => resolve()));
  }
};
await runCommandWorker(
  loadConfig(),
  {
    ...loadCommandConfig(),
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
    pollMs: 10,
    onReady: () => process.send?.({ stage: 'ready', pid: process.pid }),
    observer: {
      committed: (id) => pause('committed', id),
      deadLetterSent: (id) => pause('deadLetterSent', id),
      dlqDepth: (depth) => {
        process.send?.({ stage: 'dlqDepth', depth, pid: process.pid });
      },
    },
  },
);
