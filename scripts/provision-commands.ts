import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/config/config';
import { createSqsClient } from '../src/config/sqs';
import { loadCommandConfig } from '../src/messaging/commands/config';
export async function provisionCommandQueues(
  sqs: SQSClient,
  name = 'wager-transactions.fifo',
  maxReceiveCount = 5,
  visibilitySeconds = 30,
) {
  const callOptions = () => ({ abortSignal: AbortSignal.timeout(5000) });
  const { QueueUrl: dlq } = await sqs.send(
    new CreateQueueCommand({
      QueueName: name.replace(/\.fifo$/, '-dlq.fifo'),
      Attributes: { FifoQueue: 'true', MessageRetentionPeriod: '1209600' },
    }),
    callOptions(),
  );
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }),
    callOptions(),
  );
  if (!dlq || !Attributes?.QueueArn) throw new Error('COMMAND_DLQ_ARN_NOT_FOUND');
  const { QueueUrl: queue } = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true' } }),
    callOptions(),
  );
  if (!queue) throw new Error('COMMAND_QUEUE_URL_NOT_FOUND');
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: queue,
      Attributes: {
        VisibilityTimeout: String(visibilitySeconds),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: Attributes.QueueArn,
          maxReceiveCount,
        }),
      },
    }),
    callOptions(),
  );
  return { queue, dlq };
}
if (import.meta.main) {
  const sqs = createSqsClient(loadConfig()),
    config = loadCommandConfig();
  try {
    await provisionCommandQueues(
      sqs,
      config.queueName,
      config.maxReceiveCount,
      config.visibilitySeconds,
    );
  } finally {
    sqs.destroy();
  }
}
