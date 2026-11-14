import { expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/config/sqs';
import { loadConfig } from '../../src/config/config';
const integration = process.env.INTEGRATION === '1' ? test : test.skip;
integration(
  'FIFO deduplicates, visibility can be released, and maxReceiveCount redrives to DLQ',
  async () => {
    const sqs = createSqsClient(loadConfig());
    const queues: string[] = [];
    const create = async (attributes: Record<string, string>) => {
      const url = (
        await sqs.send(
          new CreateQueueCommand({
            QueueName: `capability-${crypto.randomUUID()}.fifo`,
            Attributes: { FifoQueue: 'true', ...attributes },
          }),
        )
      ).QueueUrl!;
      queues.push(url);
      return url;
    };
    try {
      const dlq = await create({});
      const arn = (
        await sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }),
        )
      ).Attributes!.QueueArn!;
      const queue = await create({
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: '2' }),
      });
      const send = {
        QueueUrl: queue,
        MessageGroupId: 'wallet',
        MessageDeduplicationId: 'same-operation',
        MessageBody: 'payload',
      };
      await sqs.send(new SendMessageCommand(send));
      await sqs.send(new SendMessageCommand(send));
      const receive = async (url: string) =>
        (
          await sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: url,
              MaxNumberOfMessages: 10,
              WaitTimeSeconds: 1,
            }),
          )
        ).Messages ?? [];
      const first = await receive(queue);
      expect(first).toHaveLength(1);
      expect(await receive(queue)).toHaveLength(0);
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queue,
          ReceiptHandle: first[0]!.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
      const second = await receive(queue);
      expect(second).toHaveLength(1);
      expect(second[0]!.MessageId).toBe(first[0]!.MessageId);
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queue,
          ReceiptHandle: second[0]!.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
      expect(await receive(queue)).toHaveLength(0);
      const dead = await receive(dlq);
      expect(dead).toHaveLength(1);
      expect(dead[0]!.Body).toBe('payload');
      expect(await receive(dlq)).toHaveLength(0);
    } finally {
      for (const QueueUrl of queues.reverse()) await sqs.send(new DeleteQueueCommand({ QueueUrl }));
      sqs.destroy();
    }
  },
  30000,
);

integration(
  'shared SQS client permits long polling beyond the readiness deadline',
  async () => {
    const sqs = createSqsClient(loadConfig());
    let queue: string | undefined;
    try {
      queue = (
        await sqs.send(
          new CreateQueueCommand({
            QueueName: `poll-${crypto.randomUUID()}.fifo`,
            Attributes: { FifoQueue: 'true' },
          }),
        )
      ).QueueUrl;
      const start = performance.now();
      const result = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queue, WaitTimeSeconds: 5 }),
      );
      expect(result.Messages ?? []).toHaveLength(0);
      expect(performance.now() - start).toBeGreaterThanOrEqual(4500);
    } finally {
      if (queue) await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
      sqs.destroy();
    }
  },
  15000,
);
