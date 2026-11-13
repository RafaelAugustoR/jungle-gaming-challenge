import { runWorker } from '../messaging/worker-runtime';
import { loadEventConfig } from '../messaging/outbox/config';
import { EventConsumer } from '../messaging/events/event-consumer';
import { dlqName, queueUrl } from '../messaging/queue';
import { JsonLogger } from '../observability/logger';
import { eventConsumerMetricsObserver } from '../observability/metrics.module';
async function main() {
  const options = loadEventConfig();
  await runWorker(
    'consumer',
    async ({ orm, sqs, metrics }) =>
      new EventConsumer(
        orm,
        sqs,
        await queueUrl(sqs, options.queueName),
        'demo-wallet-events',
        30,
        () => queueUrl(sqs, dlqName(options.queueName)),
        eventConsumerMetricsObserver(metrics),
      ),
    { once: process.argv.includes('--once'), pollMs: options.pollMs },
  );
}
main().catch((error: unknown) => {
  new JsonLogger().error({ event: 'event_consumer_startup_failed', error });
  process.exitCode = 1;
});
