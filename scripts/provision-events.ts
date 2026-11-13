import { CreateQueueCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/config/config';
import { createSqsClient } from '../src/config/sqs';
import { loadOutboxConfig } from '../src/messaging/outbox/config';
const sqs = createSqsClient(loadConfig());
try {
  await sqs.send(
    new CreateQueueCommand({
      QueueName: loadOutboxConfig().queueName,
      Attributes: { FifoQueue: 'true' },
    }),
  );
} finally {
  sqs.destroy();
}
