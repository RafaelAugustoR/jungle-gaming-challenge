import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { dlqName } from './queue';
export async function provisionFifoWithDlq(
  sqs: SQSClient,
  options: { name: string; maxReceiveCount: number; visibilitySeconds: number },
) {
  const callOptions = () => ({ abortSignal: AbortSignal.timeout(5000) });
  const { QueueUrl: dlq } = await sqs.send(
    new CreateQueueCommand({
      QueueName: dlqName(options.name),
      Attributes: { FifoQueue: 'true', MessageRetentionPeriod: '1209600' },
    }),
    callOptions(),
  );
  if (!dlq) throw new Error('DLQ_URL_NOT_FOUND');
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }),
    callOptions(),
  );
  if (!Attributes?.QueueArn) throw new Error('DLQ_ARN_NOT_FOUND');
  const { QueueUrl: queue } = await sqs.send(
    new CreateQueueCommand({ QueueName: options.name, Attributes: { FifoQueue: 'true' } }),
    callOptions(),
  );
  if (!queue) throw new Error('QUEUE_URL_NOT_FOUND');
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: queue,
      Attributes: {
        VisibilityTimeout: String(options.visibilitySeconds),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: Attributes.QueueArn,
          maxReceiveCount: options.maxReceiveCount,
        }),
      },
    }),
    callOptions(),
  );
  return { queue, dlq };
}
