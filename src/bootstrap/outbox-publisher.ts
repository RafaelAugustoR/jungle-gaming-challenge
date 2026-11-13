import { runMessagingWorker } from '../messaging/worker-runtime';
import { JsonLogger } from '../observability/logger';
runMessagingWorker('publisher').catch((error: unknown) => {
  new JsonLogger().error({ event: 'outbox_startup_failed', error });
  process.exitCode = 1;
});
