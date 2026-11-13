import type { SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/config/config';
import { createSqsClient } from '../src/config/sqs';
import { loadEventConfig } from '../src/messaging/outbox/config';
import { provisionFifoWithDlq } from '../src/messaging/provision-fifo-with-dlq';
export function provisionEventQueues(sqs: SQSClient, name: string) {
  return provisionFifoWithDlq(sqs, { name, maxReceiveCount: 5, visibilitySeconds: 30 });
}
if (import.meta.main) {
  const sqs = createSqsClient(loadConfig());
  try {
    await provisionEventQueues(sqs, loadEventConfig().queueName);
  } finally {
    sqs.destroy();
  }
}
