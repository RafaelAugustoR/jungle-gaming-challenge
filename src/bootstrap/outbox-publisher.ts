import { publisherMetricsObserver } from '../messaging/outbox/observability/prometheus-publisher-observer';
import { runWorker } from '../messaging/worker-runtime';
import { loadOutboxConfig } from '../messaging/outbox/config';
import { OutboxRepository } from '../messaging/outbox/outbox-repository';
import { OutboxPublisher } from '../messaging/outbox/outbox-publisher';
import { queueUrl } from '../messaging/queue';
import { JsonLogger } from '../observability/logger';

async function main() {
  const options = loadOutboxConfig();
  await runWorker(
    'publisher',
    async ({ orm, sqs, metrics }) =>
      new OutboxPublisher(
        new OutboxRepository(orm),
        sqs,
        {
          ...options,
          queueUrl: await queueUrl(sqs, options.queueName),
        },
        publisherMetricsObserver(metrics),
      ),
    {
      once: process.argv.includes('--once'),
      pollMs: options.pollMs,
      // Keep publishing while there is work; wait OUTBOX_POLL_MS only after an idle iteration.
      // Each wallet still sends one event per claim (aggregate order); see issue #27.
      continueWhen: (published) => published > 0,
    },
  );
}
main().catch((error: unknown) => {
  new JsonLogger().error({ event: 'outbox_startup_failed', error });
  process.exitCode = 1;
});
