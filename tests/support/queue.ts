import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { retryUntil } from './poll';
export async function drainQueue(sqs: SQSClient, queueUrl: string, timeoutMs = 15000) {
  await retryUntil(
    async () => {
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      return (
        Number(Attributes!.ApproximateNumberOfMessages) +
        Number(Attributes!.ApproximateNumberOfMessagesNotVisible)
      );
    },
    (count) => count === 0,
    timeoutMs,
  );
}
