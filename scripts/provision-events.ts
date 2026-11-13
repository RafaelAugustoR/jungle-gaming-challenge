import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/config/config';
import { createSqsClient } from '../src/config/sqs';
import { loadEventConfig } from '../src/messaging/outbox/config';
export async function provisionEventQueues(sqs: SQSClient, name: string) {
  const dlq = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: name.replace(/\.fifo$/, '-dlq.fifo'),
        Attributes: { FifoQueue: 'true', MessageRetentionPeriod: '1209600' },
      }),
    )
  ).QueueUrl!;
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }),
  );
  if (!Attributes?.QueueArn) throw new Error('EVENT_DLQ_ARN_NOT_FOUND');
  const queue = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: { FifoQueue: 'true' },
      }),
    )
  ).QueueUrl!;
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: queue,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: Attributes.QueueArn,
          maxReceiveCount: 5,
        }),
      },
    }),
  );
  return { queue, dlq };
}
if (import.meta.main) {
  const sqs = createSqsClient(loadConfig());
  try {
    await provisionEventQueues(sqs, loadEventConfig().queueName);
  } finally {
    sqs.destroy();
  }
}
