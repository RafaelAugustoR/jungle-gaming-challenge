import { runWorker } from '../messaging/worker-runtime';
import { loadEventConfig } from '../messaging/outbox/config';
import { EventConsumer } from '../messaging/events/event-consumer';
import { eventQueueUrl } from '../messaging/events/queue-url';
import { JsonLogger } from '../observability/logger';
async function main() {
  const options = loadEventConfig();
  await runWorker(
    'consumer',
    async ({ orm, sqs }) =>
      new EventConsumer(orm, sqs, await eventQueueUrl(sqs, options.queueName)),
    { once: process.argv.includes('--once'), pollMs: options.pollMs },
  );
}
main().catch((error: unknown) => {
  new JsonLogger().error({ event: 'event_consumer_startup_failed', error });
  process.exitCode = 1;
});
