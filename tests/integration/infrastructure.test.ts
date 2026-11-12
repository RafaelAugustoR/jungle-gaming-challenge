import { expect, test } from 'bun:test';
import { CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/config/sqs';
import { openDatabase } from '../../src/config/orm';
import { createApplication } from '../../src/bootstrap/application';

const integration = process.env.INTEGRATION === '1' ? test : test.skip;

integration('migrations reverse and restore the wagering schema in a disposable database', async () => {
  const admin = await openDatabase();
  const name = `migration_test_${crypto.randomUUID().replaceAll('-', '')}`;
  await admin.em.getConnection().execute(`create database ${name}`);
  const previous = process.env.DATABASE_URL;
  const url = new URL(previous ?? 'postgresql://jungle:local-demo-only@127.0.0.1:55439/jungle');
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
  try {
    const orm = await openDatabase();
    try {
      const exists = async () => (await orm.em.getConnection().execute("select schema_name from information_schema.schemata where schema_name = 'wagering'")).length;
      await orm.getMigrator().up(); expect(await exists()).toBe(1);
      await orm.getMigrator().down(); expect(await exists()).toBe(0);
      await orm.getMigrator().up(); expect(await exists()).toBe(1);
    } finally { await orm.close(true); }
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    await admin.em.getConnection().execute(`drop database ${name}`);
    await admin.close(true);
  }
}, 30000);

integration('SQS FIFO delivers and acknowledges an actual message', async () => {
  const sqs = createSqsClient();
  let queue: string | undefined;
  try {
    queue = (await sqs.send(new CreateQueueCommand({ QueueName: `smoke-${crypto.randomUUID()}.fifo`, Attributes: { FifoQueue: 'true' } }))).QueueUrl;
    expect(queue).toBeDefined();
    const body = JSON.stringify({ smoke: crypto.randomUUID() });
    await sqs.send(new SendMessageCommand({ QueueUrl: queue, MessageBody: body, MessageGroupId: 'smoke', MessageDeduplicationId: crypto.randomUUID() }));
    const result = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue, WaitTimeSeconds: 2 }));
    expect(result.Messages?.[0]?.Body).toBe(body);
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: result.Messages?.[0]?.ReceiptHandle }));
    expect((await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue }))).Messages ?? []).toHaveLength(0);
  } finally {
    if (queue) await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
    sqs.destroy();
  }
}, 30000);

integration('readiness succeeds with real PostgreSQL and SQS', async () => {
  const app = await createApplication();
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', checks: { postgres: true, sqs: true } });
  } finally { await app.close(); }
});
