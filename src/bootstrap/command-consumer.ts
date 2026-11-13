import 'reflect-metadata';
import { loadConfig } from '../config/config';
import { loadCommandConfig } from '../messaging/commands/config';
import { runCommandWorker } from '../messaging/commands/run-command-worker';
import { JsonLogger } from '../observability/logger';
runCommandWorker(loadConfig(), loadCommandConfig(), {
  once: process.argv.includes('--once'),
  onReady: () => process.send?.({ ready: true, pid: process.pid }),
}).catch((error) => {
  new JsonLogger().error({ event: 'command_startup_failed', error });
  process.exitCode = 1;
});
