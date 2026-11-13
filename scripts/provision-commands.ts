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
  const send = <T>(command: unknown) =>
    sqs.send(command as Parameters<SQSClient['send']>[0], {
      abortSignal: AbortSignal.timeout(5000),
    }) as Promise<T>;
  const { QueueUrl: dlq } = await send<{ QueueUrl: string }>(
    new CreateQueueCommand({
      QueueName: name.replace(/\.fifo$/, '-dlq.fifo'),
      Attributes: { FifoQueue: 'true', MessageRetentionPeriod: '1209600' },
    }),
  );
  const { Attributes } = await send<{ Attributes: Record<string, string> }>(
    new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }),
  );
  if (!Attributes.QueueArn) throw new Error('COMMAND_DLQ_ARN_NOT_FOUND');
  const { QueueUrl: queue } = await send<{ QueueUrl: string }>(
    new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true' } }),
  );
  await send(
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
