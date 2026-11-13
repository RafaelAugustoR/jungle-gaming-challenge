import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
export async function eventQueueUrl(sqs: SQSClient, name: string): Promise<string> {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }), {
    abortSignal: AbortSignal.timeout(5000),
  });
  if (!QueueUrl) throw new Error('EVENT_QUEUE_NOT_FOUND');
  return QueueUrl;
}
