import { afterEach, beforeEach, expect, test } from 'bun:test';
import { disposableDatabase } from '../support/database';
import { openDatabase } from '../../src/config/orm';
import { WalletRepository } from '../../src/modules/wallets/infrastructure/persistence/wallet-repository';
import { Wallets } from '../../src/modules/wallets/application/wallets';
import { Money } from '../../src/shared/domain/money';
import { OutboxRepository } from '../../src/messaging/outbox/outbox-repository';
const integration = process.env.INTEGRATION === '1' ? test : test.skip;
let database: Awaited<ReturnType<typeof disposableDatabase>>;
let runtime: Awaited<ReturnType<typeof openDatabase>>;
beforeEach(async () => {
  if (process.env.INTEGRATION !== '1') return;
  database = await disposableDatabase();
  runtime = await openDatabase(database.config);
});
afterEach(async () => {
  await runtime?.close(true);
  await database?.close();
});
async function opening() {
  return new Wallets(new WalletRepository(runtime), { divergence() {} }).create(
    {
      playerId: crypto.randomUUID(),
      initialBalance: Money.create('100.00', 'BRL'),
    },
    { actorId: crypto.randomUUID(), correlationId: crypto.randomUUID() },
  );
}
integration('publishers reserve disjoint heads and stale owners cannot confirm', async () => {
  const wallet = await opening();
  const repository = new OutboxRepository(runtime);
  const [first, second] = await Promise.all([
    repository.claim(1, 30_000),
    repository.claim(1, 30_000),
  ]);
  expect([...first, ...second].filter((x) => x.aggregateId === wallet.id)).toHaveLength(1);
  const event = [...first, ...second].find((x) => x.aggregateId === wallet.id)!;
  expect(await repository.confirm(event.eventId, crypto.randomUUID())).toBe(false);
  await database.owner.em.execute(
    "update wagering.outbox set lease_until=clock_timestamp()-interval '1 second' where event_id=?",
    [event.eventId],
  );
  const [replacement] = await repository.claim(1, 30000);
  expect(replacement!.eventId).toBe(event.eventId);
  expect(replacement!.token).not.toBe(event.token);
  expect(await repository.confirm(event.eventId, event.token)).toBe(false);
  expect(await repository.fail(event.eventId, event.token, 'StaleWorker', 0, true)).toBe(false);
  expect(await repository.confirm(replacement!.eventId, replacement!.token)).toBe(true);
});

integration(
  'confirmed financial events reach SQS and consumer deduplicates persistently without balance regression',
  async () => {
    const wallet = await opening();
    const { createSqsClient } = await import('../../src/config/sqs');
    const {
      CreateQueueCommand,
      DeleteQueueCommand,
      ReceiveMessageCommand,
      ChangeMessageVisibilityCommand,
      GetQueueAttributesCommand,
    } = await import('@aws-sdk/client-sqs');
    const { OutboxPublisher } = await import('../../src/messaging/outbox/outbox-publisher');
    const { EventConsumer } = await import('../../src/messaging/events/event-consumer');
    const sqs = createSqsClient(database.config);
    const queue = (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: `outbox-${crypto.randomUUID()}.fifo`,
          Attributes: { FifoQueue: 'true' },
        }),
      )
    ).QueueUrl!;
    try {
      const publisher = new OutboxPublisher(new OutboxRepository(runtime), sqs, {
        queueUrl: queue,
        leaseMs: 30000,
        sendTimeoutMs: 5000,
        batchSize: 10,
        retryBaseMs: 1,
        retryMaxMs: 10,
      });
      expect(await publisher.runOnce()).toBe(1);
      const delivered = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queue, WaitTimeSeconds: 2 }),
      );
      expect(delivered.Messages).toHaveLength(1);
      const body = delivered.Messages![0]!.Body!;
      const consumer = new EventConsumer(runtime, sqs, queue);
      expect(await consumer.accept(body)).toBe('processed');
      expect(await consumer.accept(body)).toBe('duplicate');
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queue,
          ReceiptHandle: delivered.Messages![0]!.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
      expect(await consumer.runOnce()).toBe(1);
      const afterAck = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queue,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      expect(afterAck.Attributes).toMatchObject({
        ApproximateNumberOfMessages: '0',
        ApproximateNumberOfMessagesNotVisible: '0',
      });
      const event = JSON.parse(body);
      await consumer.accept(
        JSON.stringify({
          ...event,
          eventId: crypto.randomUUID(),
          sequence: 3,
          data: {
            ...event.data,
            balanceAfter: { amount: '150.00', currency: 'BRL' },
            walletVersion: 3,
          },
        }),
      );
      await consumer.accept(
        JSON.stringify({
          ...event,
          eventId: crypto.randomUUID(),
          sequence: 2,
          data: {
            ...event.data,
            balanceAfter: { amount: '90.00', currency: 'BRL' },
            walletVersion: 2,
          },
        }),
      );
      const [projection] = await runtime.em
        .fork()
        .execute(
          'select sequence,balance,wallet_version from wagering.event_projection where aggregate_id=?',
          [wallet.id],
        );
      expect(projection).toMatchObject({
        sequence: 3,
        balance: { amount: '150.00', currency: 'BRL' },
        wallet_version: 3,
      });
      await expect(
        consumer.accept(JSON.stringify({ ...event, correlationId: 'different-content' })),
      ).rejects.toThrow();
      const [{ count }] = await runtime.em
        .fork()
        .execute('select count(*)::int as count from wagering.event_inbox');
      expect(count).toBe(3);
    } finally {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
      sqs.destroy();
    }
  },
  30000,
);

integration(
  'leases recover crashed publishers before send and after SQS send without losing the committed event',
  async () => {
    const { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand } =
      await import('@aws-sdk/client-sqs');
    const { createSqsClient } = await import('../../src/config/sqs');
    const { OutboxPublisher } = await import('../../src/messaging/outbox/outbox-publisher');
    const { fork } = await import('node:child_process');
    const sqs = createSqsClient(database.config);
    const queue = (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: `crash-${crypto.randomUUID()}.fifo`,
          Attributes: { FifoQueue: 'true' },
        }),
      )
    ).QueueUrl!;
    try {
      for (const stage of ['reserved', 'sent']) {
        const wallet = await opening();
        const child = fork(new URL('../support/outbox-process.ts', import.meta.url).pathname, [], {
          execPath: process.execPath,
          env: {
            ...process.env,
            DATABASE_URL: database.config.databaseUrl,
            OUTBOX_TEST_QUEUE: queue,
            OUTBOX_TEST_PAUSE: stage,
          },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr?.on('data', (chunk) => {
          stderr += chunk;
        });
        const reached = await new Promise<{ eventId: string; token: string; pid: number }>(
          (resolve, reject) => {
            const timer = setTimeout(() => {
              child.kill('SIGKILL');
              reject(new Error(`Publisher did not reach ${stage}: ${stderr}`));
            }, 10000);
            child.on('message', (message) => {
              const value = message as {
                stage: string;
                eventId: string;
                token: string;
                pid: number;
              };
              if (value.stage === stage) {
                clearTimeout(timer);
                resolve(value);
              }
            });
            child.on('exit', (code) => {
              if (code !== null) {
                clearTimeout(timer);
                reject(new Error(`Publisher exited ${code}: ${stderr}`));
              }
            });
          },
        );
        const exit = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exit;
        // Model the lease deadline in the persisted clock, not a timing race in the test runner.
        await database.owner.em.execute(
          "update wagering.outbox set lease_until=clock_timestamp()-interval '1 second' where event_id=?",
          [reached.eventId],
        );
        const repository = new OutboxRepository(runtime);
        expect(await repository.confirm(reached.eventId, reached.token)).toBe(false);
        const publisher = new OutboxPublisher(repository, sqs, {
          queueUrl: queue,
          leaseMs: 30000,
          sendTimeoutMs: 5000,
          batchSize: 10,
          retryBaseMs: 1,
          retryMaxMs: 10,
        });
        expect(await publisher.runOnce()).toBe(1);
        const [state] = await database.owner.em.execute(
          'select event_id,published_at,attempts from wagering.outbox where aggregate_id=?',
          [wallet.id],
        );
        expect(state.event_id).toBe(reached.eventId);
        expect(state.published_at).not.toBeNull();
        expect(state.attempts).toBe(2);
        const delivery = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queue,
            WaitTimeSeconds: 2,
            MaxNumberOfMessages: 10,
          }),
        );
        expect(
          delivery.Messages?.some((m) => JSON.parse(m.Body!).eventId === reached.eventId),
        ).toBe(true);
      }
    } finally {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
      sqs.destroy();
    }
  },
  30000,
);

integration(
  'retry preserves head ordering, permanent errors remain retained and runtime cannot mutate payload',
  async () => {
    const wallet = await opening();
    const repository = new OutboxRepository(runtime);
    const [event] = await repository.claim(10, 30000);
    expect(event).toBeDefined();
    expect(
      await repository.fail(event!.eventId, event!.token, 'TransportFailure', 60000, false),
    ).toBe(true);
    expect(await repository.claim(10, 30000)).toHaveLength(0);
    const other = await opening();
    expect((await repository.claim(10, 30000)).map((x) => x.aggregateId)).toEqual([other.id]);
    await database.owner.em.execute(
      'update wagering.outbox set next_attempt_at=clock_timestamp() where event_id=?',
      [event!.eventId],
    );
    const [retry] = await repository.claim(10, 30000);
    expect(retry!.eventId).toBe(event!.eventId);
    expect(
      await repository.fail(retry!.eventId, retry!.token, 'InvalidIntegrationEvent', 0, true),
    ).toBe(true);
    expect(await repository.claim(10, 30000)).toHaveLength(0);
    expect(await repository.retryBlocked(retry!.eventId)).toBe(true);
    expect((await repository.claim(10, 30000))[0]!.eventId).toBe(event!.eventId);
    await expect(
      runtime.em
        .fork()
        .execute("update wagering.outbox set payload='{}'::jsonb where aggregate_id=?", [
          wallet.id,
        ]),
    ).rejects.toThrow();
    await expect(
      runtime.em.fork().execute('delete from wagering.outbox where aggregate_id=?', [wallet.id]),
    ).rejects.toThrow();
  },
);

integration('later wallet events remain blocked behind an unpublished head', async () => {
  const wallet = await opening();
  const { SubmitWagerTransaction } =
    await import('../../src/modules/wagering/application/submit-wager-transaction');
  const { WageringRepository } =
    await import('../../src/modules/wagering/infrastructure/persistence/wagering-repository');
  const command = {
    providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'r',
    gameId: 'g',
    kind: 'BET' as const,
    money: Money.create('10.00', 'BRL'),
  };
  await new SubmitWagerTransaction(
    new WageringRepository(runtime, database.config),
    new Set(['provider-a']),
  ).execute(command, command.externalTransactionId, { correlationId: crypto.randomUUID() });
  const repository = new OutboxRepository(runtime);
  const [head] = await repository.claim(10, 30000);
  expect(head!.sequence).toBe(1);
  expect(await repository.claim(10, 30000)).toHaveLength(0);
  expect(await repository.confirm(head!.eventId, head!.token)).toBe(true);
  const [next] = await repository.claim(10, 30000);
  expect(next!.sequence).toBe(2);
  expect(await repository.claim(10, 30000)).toHaveLength(0);
  await repository.confirm(next!.eventId, next!.token);
  expect((await repository.claim(10, 30000))[0]!.sequence).toBe(3);
});

integration(
  'two publisher processes concurrently publish disjoint wallet heads',
  async () => {
    const { CreateQueueCommand, DeleteQueueCommand } = await import('@aws-sdk/client-sqs');
    const { createSqsClient } = await import('../../src/config/sqs');
    const { fork } = await import('node:child_process');
    for (let i = 0; i < 6; i++) await opening();
    const sqs = createSqsClient(database.config);
    const queue = (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: `parallel-${crypto.randomUUID()}.fifo`,
          Attributes: { FifoQueue: 'true' },
        }),
      )
    ).QueueUrl!;
    const run = () =>
      new Promise<{ pid: number; sent: string[] }>((resolve, reject) => {
        const child = fork(new URL('../support/outbox-process.ts', import.meta.url).pathname, [], {
          execPath: process.execPath,
          env: {
            ...process.env,
            DATABASE_URL: database.config.databaseUrl,
            OUTBOX_TEST_QUEUE: queue,
            OUTBOX_TEST_BATCH: '3',
          },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        const sent: string[] = [];
        let stderr = '';
        child.stderr?.on('data', (chunk) => {
          stderr += chunk;
        });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Publisher timed out'));
        }, 10000);
        child.on('message', (raw) => {
          const message = raw as { stage: string; eventId: string };
          if (message.stage === 'sent') sent.push(message.eventId);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve({ pid: child.pid!, sent });
          else reject(new Error(`Publisher exit ${code}: ${stderr}`));
        });
      });
    try {
      const [first, second] = await Promise.all([run(), run()]);
      expect(first.pid).not.toBe(second.pid);
      expect(first.sent).toHaveLength(3);
      expect(second.sent).toHaveLength(3);
      const ids = [...first.sent, ...second.sent];
      expect(ids).toHaveLength(6);
      expect(new Set(ids).size).toBe(6);
      const [{ count }] = await database.owner.em.execute(
        'select count(*)::int as count from wagering.outbox where published_at is not null',
      );
      expect(count).toBe(6);
    } finally {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
      sqs.destroy();
    }
  },
  30000,
);

integration(
  'failed sends retry and invalid committed payloads block without being discarded',
  async () => {
    const wallet = await opening();
    const { createSqsClient } = await import('../../src/config/sqs');
    const { OutboxPublisher } = await import('../../src/messaging/outbox/outbox-publisher');
    const sqs = createSqsClient(database.config);
    const repository = new OutboxRepository(runtime);
    try {
      const publisher = new OutboxPublisher(repository, sqs, {
        queueUrl: `${database.config.sqsEndpoint}/000000000000/missing-${crypto.randomUUID()}.fifo`,
        leaseMs: 30000,
        sendTimeoutMs: 1000,
        batchSize: 10,
        retryBaseMs: 10000,
        retryMaxMs: 10000,
      });
      expect(await publisher.runOnce()).toBe(1);
      const [state] = await database.owner.em.execute(
        'select published_at,lease_token,blocked_at,attempts,last_error_code,next_attempt_at>clock_timestamp() as waiting from wagering.outbox where aggregate_id=?',
        [wallet.id],
      );
      expect(state).toMatchObject({
        published_at: null,
        lease_token: null,
        blocked_at: null,
        attempts: 1,
        waiting: true,
      });
      expect(state.last_error_code).toBeString();
      await database.owner.em.fork().transactional(async (em) => {
        await em.execute('alter table wagering.outbox disable trigger outbox_identity');
        await em.execute(
          "update wagering.outbox set payload='{}'::jsonb,next_attempt_at=clock_timestamp() where aggregate_id=?",
          [wallet.id],
        );
        await em.execute('alter table wagering.outbox enable trigger outbox_identity');
      });
      expect(await publisher.runOnce()).toBe(1);
      const [blocked] = await database.owner.em.execute(
        'select published_at,blocked_at,last_error_code from wagering.outbox where aggregate_id=?',
        [wallet.id],
      );
      expect(blocked.published_at).toBeNull();
      expect(blocked.blocked_at).not.toBeNull();
      expect(blocked.last_error_code).toBe('InvalidIntegrationEvent');
      expect(await publisher.runOnce()).toBe(0);
    } finally {
      sqs.destroy();
    }
  },
  15000,
);

integration('consumer commits inbox and projection atomically', async () => {
  const wallet = await opening();
  const { createSqsClient } = await import('../../src/config/sqs');
  const { EventConsumer } = await import('../../src/messaging/events/event-consumer');
  const sqs = createSqsClient(database.config);
  try {
    const [event] = await new OutboxRepository(runtime).claim(1, 30000);
    const body = JSON.stringify({ ...event!.payload, sequence: event!.sequence });
    await database.owner.em
      .execute(`create function wagering.fail_projection() returns trigger language plpgsql as $$ begin raise exception 'injected projection failure'; end $$;
      create trigger fail_projection before insert on wagering.event_projection for each row execute function wagering.fail_projection();`);
    const consumer = new EventConsumer(runtime, sqs, 'unused');
    await expect(consumer.accept(body)).rejects.toThrow('injected projection failure');
    expect(await runtime.em.fork().execute('select * from wagering.event_inbox')).toHaveLength(0);
    expect(await runtime.em.fork().execute('select * from wagering.event_projection')).toHaveLength(
      0,
    );
    await database.owner.em.execute(
      'drop trigger fail_projection on wagering.event_projection; drop function wagering.fail_projection();',
    );
    expect(await consumer.accept(body)).toBe('processed');
    const [projection] = await runtime.em
      .fork()
      .execute('select aggregate_id from wagering.event_projection');
    expect(projection.aggregate_id).toBe(wallet.id);
  } finally {
    sqs.destroy();
  }
});

integration(
  'production worker entrypoints publish and consume without an HTTP server',
  async () => {
    const wallet = await opening();
    const { CreateQueueCommand, DeleteQueueCommand } = await import('@aws-sdk/client-sqs');
    const { createSqsClient } = await import('../../src/config/sqs');
    const sqs = createSqsClient(database.config);
    const name = `bootstrap-${crypto.randomUUID()}.fifo`;
    const queue = (
      await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true' } }))
    ).QueueUrl!;
    try {
      const run = async (entry: string) => {
        const child = Bun.spawn([process.execPath, entry, '--once'], {
          cwd: new URL('../..', import.meta.url).pathname,
          env: {
            ...process.env,
            DATABASE_URL: database.config.databaseUrl,
            OUTBOX_QUEUE_NAME: name,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const deadline = setTimeout(() => child.kill('SIGKILL'), 15000);
        try {
          const [code, out, error] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          if (code !== 0) throw new Error(`Worker exit ${code}: ${error} ${out}`);
          expect(out).toContain('worker_started');
          expect(out).toContain('worker_stopped');
          return child.pid;
        } finally {
          clearTimeout(deadline);
        }
      };
      const publisher = await run('src/bootstrap/outbox-publisher.ts');
      const consumer = await run('src/bootstrap/event-consumer.ts');
      expect(publisher).not.toBe(consumer);
      const [projection] = await runtime.em
        .fork()
        .execute('select balance from wagering.event_projection where aggregate_id=?', [wallet.id]);
      expect(projection.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    } finally {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
      sqs.destroy();
    }
  },
  30000,
);
