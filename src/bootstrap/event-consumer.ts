import { runMessagingWorker } from '../messaging/worker-runtime';
import { JsonLogger } from '../observability/logger';
runMessagingWorker('consumer').catch((error: unknown) => {
  new JsonLogger().error({ event: 'event_consumer_startup_failed', error });
  process.exitCode = 1;
});
