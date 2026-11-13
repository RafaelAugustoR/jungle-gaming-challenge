import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
export function dlqName(name: string): string {
  return name.replace(/\.fifo$/, '-dlq.fifo');
}
export async function queueUrl(
  sqs: SQSClient,
  name: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 5000);
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }), {
    abortSignal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (!QueueUrl) throw new Error('QUEUE_NOT_FOUND');
  return QueueUrl;
}
