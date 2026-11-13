import { eventConsumerMetricsObserver } from '../messaging/events/observability/prometheus-event-observer';
import { runWorker } from '../messaging/worker-runtime';
import { loadEventConfig } from '../messaging/outbox/config';
import { EventConsumer } from '../messaging/events/event-consumer';
import { dlqName, queueUrl } from '../messaging/queue';
import { JsonLogger } from '../observability/logger';

async function main() {
  const options = loadEventConfig();
  await runWorker(
    'consumer',
    async ({ orm, sqs, metrics }) =>
      new EventConsumer(orm, sqs, await queueUrl(sqs, options.queueName), {
        dlqUrl: () => queueUrl(sqs, dlqName(options.queueName)),
        observer: eventConsumerMetricsObserver(metrics),
      }),
    { once: process.argv.includes('--once'), pollMs: options.pollMs },
  );
}
main().catch((error: unknown) => {
  new JsonLogger().error({ event: 'event_consumer_startup_failed', error });
  process.exitCode = 1;
});
