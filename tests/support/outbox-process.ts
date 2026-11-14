import { openDatabase } from '../../src/config/orm';
import { loadConfig } from '../../src/config/config';
import { createSqsClient } from '../../src/config/sqs';
import { OutboxRepository, type ReservedEvent } from '../../src/messaging/outbox/outbox-repository';
import { OutboxPublisher } from '../../src/messaging/outbox/outbox-publisher';
const config = loadConfig();
const orm = await openDatabase(config),
  sqs = createSqsClient(config);
const mode = process.env.OUTBOX_TEST_PAUSE;
const pause = async (stage: string, event: ReservedEvent) => {
  process.send?.({ stage, eventId: event.message.eventId, token: event.token, pid: process.pid });
  if (mode === stage)
    await new Promise<void>((resolve) => process.once('message', () => resolve()));
};
try {
  const publisher = new OutboxPublisher(
    new OutboxRepository(orm),
    sqs,
    {
      queueUrl: process.env.OUTBOX_TEST_QUEUE!,
      leaseMs: Number(process.env.OUTBOX_TEST_LEASE ?? 1000),
      sendTimeoutMs: 500,
      batchSize: Number(process.env.OUTBOX_TEST_BATCH ?? 10),
      retryBaseMs: 10,
      retryMaxMs: 20,
    },
    { reserved: (event) => pause('reserved', event), sent: (event) => pause('sent', event) },
  );
  await publisher.runOnce();
  process.send?.({ stage: 'done', pid: process.pid });
} finally {
  sqs.destroy();
  await orm.close(true);
  process.disconnect?.();
}
