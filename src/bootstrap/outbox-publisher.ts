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
      new OutboxPublisher(new OutboxRepository(orm), sqs, {
        ...options,
        queueUrl: await queueUrl(sqs, options.queueName),
      }, undefined, metrics),
    { once: process.argv.includes('--once'), pollMs: options.pollMs },
  );
}
main().catch((error: unknown) => {
  new JsonLogger().error({ event: 'outbox_startup_failed', error });
  process.exitCode = 1;
});
