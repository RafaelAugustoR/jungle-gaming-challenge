import type { SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/config/config';
import { createSqsClient } from '../src/config/sqs';
import { loadCommandConfig } from '../src/messaging/commands/config';
import { provisionFifoWithDlq } from '../src/messaging/provision-fifo-with-dlq';
export function provisionCommandQueues(sqs: SQSClient, options = loadCommandConfig()) {
  return provisionFifoWithDlq(sqs, {
    name: options.queueName,
    maxReceiveCount: options.maxReceiveCount,
    visibilitySeconds: options.visibilitySeconds,
  });
}
if (import.meta.main) {
  const sqs = createSqsClient(loadConfig());
  try {
    await provisionCommandQueues(sqs);
  } finally {
    sqs.destroy();
  }
}
