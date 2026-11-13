import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { disposableDatabase } from '../support/database';
import { openDatabase } from '../../src/config/orm';
import { createSqsClient } from '../../src/config/sqs';
import { Wallets } from '../../src/modules/wallets/application/wallets';
import { WalletRepository } from '../../src/modules/wallets/infrastructure/persistence/wallet-repository';
import { Money } from '../../src/shared/domain/money';
const integration = process.env.INTEGRATION === '1' ? test : test.skip;
let database: Awaited<ReturnType<typeof disposableDatabase>>;
let orm: Awaited<ReturnType<typeof openDatabase>>;
let sqs: ReturnType<typeof createSqsClient>;
let queue: string, dlq: string;
beforeAll(async () => {
  if (process.env.INTEGRATION !== '1') return;
  database = await disposableDatabase();
  orm = await openDatabase(database.config);
  sqs = createSqsClient(database.config);
});
beforeEach(async () => {
  if (process.env.INTEGRATION !== '1') return;
  queue = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: `commands-${crypto.randomUUID()}.fifo`,
        Attributes: { FifoQueue: 'true' },
      }),
    )
  ).QueueUrl!;
  dlq = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: `commands-dlq-${crypto.randomUUID()}.fifo`,
        Attributes: { FifoQueue: 'true' },
      }),
    )
  ).QueueUrl!;
});
afterEach(async () => {
  if (sqs) {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
    await sqs.send(new DeleteQueueCommand({ QueueUrl: dlq }));
  }
});
afterAll(async () => {
  sqs?.destroy();
  await orm?.close(true);
  await database?.close();
});
async function fixture() {
  const wallet = await new Wallets(new WalletRepository(orm), { divergence() {} }).create(
    { playerId: crypto.randomUUID(), initialBalance: Money.create('100.00', 'BRL') },
    { actorId: crypto.randomUUID(), correlationId: crypto.randomUUID() },
  );
  return {
    wallet,
    envelope: {
      messageId: crypto.randomUUID(),
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'r',
        gameId: 'g',
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' },
      },
    },
  };
}
async function send(envelope: Awaited<ReturnType<typeof fixture>>['envelope']) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queue,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: envelope.data.walletId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}
async function consumer(
  overrides: Partial<
    import('../../src/messaging/commands/command-consumer').CommandConsumerOptions
  > = {},
) {
  const { CommandConsumer } = await import('../../src/messaging/commands/command-consumer');
  return new CommandConsumer(orm, sqs, database.config, {
    queueUrl: queue,
    dlqUrl: dlq,
    visibilitySeconds: 30,
    callTimeoutMs: 5000,
    retryBaseMs: 1000,
    retryMaxMs: 30000,
    waitSeconds: 0,
    drainMs: 20000,
    ...overrides,
  });
}
integration(
  'SQS duplicates beyond FIFO deduplication debit once and commit one inbox with the financial result',
  async () => {
    const { wallet, envelope } = await fixture();
    const worker = await consumer();
    await send(envelope);
    expect(await worker.runOnce()).toBe(1);
    await send({ ...envelope, occurredAt: '2026-01-01T00:00:00.000Z' });
    expect(await worker.runOnce()).toBe(1);
    const result = await new Wallets(new WalletRepository(orm), { divergence() {} }).get(wallet.id);
    expect(result.balance.toProps()).toEqual({ amount: '80.00', currency: 'BRL' });
    expect(result.version).toBe(2);
    const rows = await orm.em
      .fork()
      .execute('select * from messaging.command_inbox where message_id=?', [envelope.messageId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].transaction_id).toBeString();
    expect(
      (await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue, WaitTimeSeconds: 0 })))
        .Messages ?? [],
    ).toHaveLength(0);
  },
);
integration(
  'a divergent business messageId goes to DLQ without overwriting the inbox or debiting again',
  async () => {
    const { wallet, envelope } = await fixture(),
      worker = await consumer();
    await send(envelope);
    await worker.runOnce();
    await send({
      ...envelope,
      data: { ...envelope.data, money: { amount: '30.00', currency: 'BRL' } },
    });
    await worker.runOnce();
    const dead = (await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 0 })))
      .Messages!;
    expect(dead).toHaveLength(1);
    expect(dead[0]!.MessageAttributes).toBeUndefined();
    const diagnostic = JSON.parse(dead[0]!.Body!);
    expect(diagnostic).toMatchObject({
      reason: 'INBOX_CONFLICT',
      originalMessageId: envelope.messageId,
    });
    expect(JSON.parse(diagnostic.originalBody).data.money.amount).toBe('30.00');
    const result = await new Wallets(new WalletRepository(orm), { divergence() {} }).get(wallet.id);
    expect(result.balance.toProps().amount).toBe('80.00');
    const { DeleteMessageCommand } = await import('@aws-sdk/client-sqs');
    await sqs.send(
      new DeleteMessageCommand({ QueueUrl: dlq, ReceiptHandle: dead[0]!.ReceiptHandle! }),
    );
  },
);
integration(
  'provisioning is repeatable and installs maxReceiveCount=5 on the required command queue',
  async () => {
    const { provisionCommandQueues } = await import('../../scripts/provision-commands');
    const { GetQueueAttributesCommand } = await import('@aws-sdk/client-sqs');
    const name = `provision-commands-${crypto.randomUUID()}.fifo`;
    const queues = await provisionCommandQueues(sqs, name);
    try {
      expect(await provisionCommandQueues(sqs, name)).toEqual(queues);
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queues.queue,
          AttributeNames: ['RedrivePolicy', 'VisibilityTimeout'],
        }),
      );
      expect(JSON.parse(Attributes!.RedrivePolicy!).maxReceiveCount).toBe(5);
      expect(Attributes!.VisibilityTimeout).toBe('30');
    } finally {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queues.queue }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queues.dlq }));
    }
  },
);
integration(
  'HTTP then SQS and SQS then HTTP preserve the original receipt and financial idempotency',
  async () => {
    const { createApplication } = await import('../../src/bootstrap/application');
    const { providerToken } = await import('../support/keycloak');
    const app = await createApplication(database.config);
    await app.listen(0, '127.0.0.1');
    try {
      const base = await app.getUrl(),
        token = await providerToken('a'),
        worker = await consumer();
      const http = async (data: Awaited<ReturnType<typeof fixture>>['envelope']['data']) => {
        const { idempotencyKey, ...body } = data;
        const response = await fetch(`${base}/wagering/transactions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as any;
      };
      for (const httpFirst of [true, false]) {
        const { wallet, envelope } = await fixture();
        let receipt: any;
        if (httpFirst) receipt = await http(envelope.data);
        await send(envelope);
        await worker.runOnce();
        if (!httpFirst) {
          receipt = await http(envelope.data);
          expect(receipt.idempotentReplay).toBe(true);
        }
        // Another business message can replay the accepted operation without new events.
        await send({ ...envelope, messageId: crypto.randomUUID() });
        await worker.runOnce();
        const replay = await http(envelope.data);
        expect(replay).toEqual({ ...receipt, idempotentReplay: true });
        expect(
          (
            await new Wallets(new WalletRepository(orm), { divergence() {} }).get(wallet.id)
          ).balance.toProps().amount,
        ).toBe('80.00');
        const [{ count }] = await orm.em
          .fork()
          .execute(
            'select count(*)::int as count from messaging.command_inbox where transaction_id=?',
            [receipt.transactionId],
          );
        expect(count).toBe(2);
      }
    } finally {
      await app.close();
    }
  },
  20000,
);

integration(
  'a failed inbox completion rolls back wallet, ledger, receipt and outbox before retry',
  async () => {
    const { wallet, envelope } = await fixture(),
      worker = await consumer();
    await database.owner.em
      .execute(`create function messaging.fail_inbox_test() returns trigger language plpgsql as $$ begin raise exception 'injected inbox failure'; end $$;
 create trigger fail_inbox_test before update on messaging.command_inbox for each row execute function messaging.fail_inbox_test();`);
    try {
      await send(envelope);
      await worker.runOnce();
      expect(
        (
          await new Wallets(new WalletRepository(orm), { divergence() {} }).get(wallet.id)
        ).balance.toProps().amount,
      ).toBe('100.00');
      expect(
        await orm.em
          .fork()
          .execute('select * from messaging.command_inbox where message_id=?', [
            envelope.messageId,
          ]),
      ).toHaveLength(0);
      expect(
        await orm.em
          .fork()
          .execute('select * from wagering.transactions where external_transaction_id=?', [
            envelope.data.externalTransactionId,
          ]),
      ).toHaveLength(0);
    } finally {
      await database.owner.em.execute(
        'drop trigger fail_inbox_test on messaging.command_inbox;drop function messaging.fail_inbox_test();',
      );
    }
    // Retry uses the same real receipt; no reinjection into the queue.
    await retryUntil(
      () => worker.runOnce(),
      (n) => n === 1,
    );
    expect(
      (
        await new Wallets(new WalletRepository(orm), { divergence() {} }).get(wallet.id)
      ).balance.toProps().amount,
    ).toBe('80.00');
  },
);
async function retryUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 8000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (done(value)) return value;
    await Bun.sleep(25);
  } while (Date.now() < end);
  throw new Error('Condition did not become true');
}
integration(
  'SIGKILL after commit before ack redelivers to another process without a second debit',
  async () => {
    const { commandWorker } = await import('../support/command-worker');
    const { wallet, envelope } = await fixture();
    await send(envelope);
    const first = commandWorker(database.config, queue, dlq, { COMMAND_TEST_PAUSE: 'committed' });
    try {
      const committed = await first.wait('committed');
      expect(committed.messageId).toBe(envelope.messageId);
      await first.stop('SIGKILL');
      const second = commandWorker(database.config, queue, dlq);
      try {
        await second.wait('committed');
        expect(second.child.pid).not.toBe(first.child.pid);
      } finally {
        await second.stop();
      }
      const w = await new Wallets(new WalletRepository(orm), { divergence() {} }).get(wallet.id);
      expect(w.balance.toProps().amount).toBe('80.00');
      expect(w.version).toBe(2);
      const [{ count }] = await orm.em
        .fork()
        .execute('select count(*)::int as count from messaging.command_inbox where message_id=?', [
          envelope.messageId,
        ]);
      expect(count).toBe(1);
      expect(
        (await new Wallets(new WalletRepository(orm), { divergence() {} }).reconcile(wallet.id))
          .consistent,
      ).toBe(true);
    } finally {
      await first.stop('SIGKILL');
    }
  },
  15000,
);
integration(
  'a missing DLQ retains the source and recovers without losing a poison message',
  async () => {
    const { CommandConsumer } = await import('../../src/messaging/commands/command-consumer');
    const { wallet, envelope } = await fixture();
    envelope.data.providerId = 'unknown';
    await send(envelope);
    const worker = new CommandConsumer(orm, sqs, database.config, {
      queueUrl: queue,
      dlqUrl: queue.replace(/[^/]+$/, 'missing-dlq.fifo'),
      visibilitySeconds: 30,
      callTimeoutMs: 500,
      retryBaseMs: 1,
      retryMaxMs: 1,
      waitSeconds: 0,
      drainMs: 100,
    });
    await worker.runOnce();
    const healthy = await consumer();
    await retryUntil(
      () => healthy.runOnce(),
      (n) => n === 1,
    );
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 0 }),
    );
    expect(JSON.parse(Messages![0]!.Body!)).toMatchObject({
      reason: 'UNKNOWN_PROVIDER',
      originalMessageId: envelope.messageId,
    });
    expect(
      (
        await new Wallets(new WalletRepository(orm), { divergence() {} }).get(wallet.id)
      ).balance.toProps().amount,
    ).toBe('100.00');
  },
);

integration(
  'death between DLQ send and source delete redelivers safely with deterministic FIFO deduplication',
  async () => {
    const { commandWorker } = await import('../support/command-worker');
    const { envelope } = await fixture();
    envelope.data.providerId = 'unknown';
    await send(envelope);
    const first = commandWorker(database.config, queue, dlq, {
      COMMAND_TEST_PAUSE: 'deadLetterSent',
    });
    try {
      await first.wait('deadLetterSent');
      await first.stop('SIGKILL');
      const healthy = await consumer();
      await retryUntil(
        () => healthy.runOnce(),
        (n) => n === 1,
      );
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: dlq, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
      );
      expect(Messages).toHaveLength(1);
      expect(JSON.parse(Messages![0]!.Body!).originalMessageId).toBe(envelope.messageId);
      expect(
        (await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue, WaitTimeSeconds: 0 })))
          .Messages ?? [],
      ).toHaveLength(0);
    } finally {
      await first.stop('SIGKILL');
    }
  },
  15000,
);

integration(
  'native redrive sends the fifth exhausted transient processing attempt to DLQ without financial rejection',
  async () => {
    const { provisionCommandQueues } = await import('../../scripts/provision-commands');
    await provisionCommandQueues(sqs, queue.split('/').at(-1)!, 5, 1);
    // Provisioner uses the paired queue name; replace this test's independently named DLQ.
    await sqs.send(new DeleteQueueCommand({ QueueUrl: dlq }));
    dlq = queue.replace(/\.fifo$/, '-dlq.fifo');
    const { wallet, envelope } = await fixture();
    await send(envelope);
    await database.owner.em
      .execute(`create function messaging.fail_retry_test() returns trigger language plpgsql as $$ begin raise exception 'injected unavailable persistence'; end $$;
 create trigger fail_retry_test before insert on messaging.command_inbox for each row execute function messaging.fail_retry_test();`);
    try {
      const worker = await consumer({ retryBaseMs: 1, retryMaxMs: 1 });
      for (let i = 0; i < 5; i++)
        await retryUntil(
          () => worker.runOnce(),
          (n) => n === 1,
        );
      const dead = await retryUntil(
        async () => {
          await worker.runOnce();
          return (
            (await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 0 })))
              .Messages ?? []
          );
        },
        (messages) => messages.length > 0,
      );
      expect(JSON.parse(dead[0]!.Body!).messageId).toBe(envelope.messageId);
      expect(
        (
          await new Wallets(new WalletRepository(orm), { divergence() {} }).get(wallet.id)
        ).balance.toProps().amount,
      ).toBe('100.00');
      expect(
        await orm.em
          .fork()
          .execute('select * from wagering.transactions where external_transaction_id=?', [
            envelope.data.externalTransactionId,
          ]),
      ).toHaveLength(0);
    } finally {
      await database.owner.em.execute(
        'drop trigger fail_retry_test on messaging.command_inbox;drop function messaging.fail_retry_test();',
      );
    }
  },
  20000,
);
integration(
  'SIGTERM cancels SQL and rolls back before returning visibility, while heartbeats protect active work',
  async () => {
    const { commandWorker } = await import('../support/command-worker');
    const { wallet, envelope } = await fixture();
    const locker = database.owner.em.fork();
    await locker.begin();
    await locker.execute('select id from wagering.wallets where id=? for update', [wallet.id]);
    await send(envelope);
    const worker = commandWorker(database.config, queue, dlq, {
      COMMAND_TEST_DRAIN: '100',
      FINANCIAL_LOCK_TIMEOUT_MS: '10000',
      FINANCIAL_STATEMENT_TIMEOUT_MS: '10000',
    });
    try {
      await worker.wait('ready');
      await retryUntil(
        () =>
          database.owner.em
            .fork()
            .execute<
              { waiting: boolean }[]
            >(`select exists(select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock') as waiting`),
        (r) => r[0]!.waiting,
      );
      // Observe several visibility-renewal cycles while a real PostgreSQL lock keeps work in flight.
      const end = Date.now() + 1500;
      do {
        expect(
          (await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue, WaitTimeSeconds: 0 })))
            .Messages ?? [],
        ).toHaveLength(0);
        await Bun.sleep(100);
      } while (Date.now() < end);
      const started = Date.now();
      expect(await worker.stop()).toBe(0);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(
        await orm.em
          .fork()
          .execute('select * from messaging.command_inbox where message_id=?', [
            envelope.messageId,
          ]),
      ).toHaveLength(0);
      await locker.rollback();
      expect(await (await consumer()).runOnce()).toBe(1);
      expect(
        (
          await new Wallets(new WalletRepository(orm), { divergence() {} }).get(wallet.id)
        ).balance.toProps().amount,
      ).toBe('80.00');
    } finally {
      if (locker.isInTransaction()) await locker.rollback();
      await worker.stop('SIGKILL');
    }
  },
  15000,
);

integration(
  'pending SQS REFUND is acked so its BET can arrive in the same FIFO group, then #6 completes it',
  async () => {
    const { envelope, wallet } = await fixture();
    const refund = {
      ...envelope,
      messageId: crypto.randomUUID(),
      data: {
        ...envelope.data,
        kind: 'REFUND',
        externalTransactionId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        referenceExternalTransactionId: envelope.data.externalTransactionId,
      },
    };
    await send(refund);
    const worker = await consumer();
    await worker.runOnce();
    const pending = await orm.em
      .fork()
      .execute('select status from wagering.transactions where external_transaction_id=?', [
        refund.data.externalTransactionId,
      ]);
    expect(pending[0].status).toBe('PENDING_REFERENCE');
    await send(envelope);
    expect(await worker.runOnce()).toBe(1);
    const { ReprocessReferences } =
      await import('../../src/modules/wagering/application/reprocess-references');
    const { WageringRepository } =
      await import('../../src/modules/wagering/infrastructure/persistence/wagering-repository');
    const { ReferenceRetryPolicy } =
      await import('../../src/modules/wagering/domain/reference-retry');
    const reprocess = new ReprocessReferences(
      new WageringRepository(orm, database.config),
      new ReferenceRetryPolicy({ ttlMs: 900000, baseMs: 1, maxMs: 1 }),
    );
    await retryUntil(
      async () => {
        await reprocess.runBatch(10);
        return (
          await orm.em
            .fork()
            .execute('select status from wagering.transactions where external_transaction_id=?', [
              refund.data.externalTransactionId,
            ])
        )[0].status;
      },
      (status) => status === 'PROCESSED',
    );
    expect(
      (
        await new Wallets(new WalletRepository(orm), { divergence() {} }).get(wallet.id)
      ).balance.toProps().amount,
    ).toBe('100.00');
    expect(
      (await new Wallets(new WalletRepository(orm), { divergence() {} }).reconcile(wallet.id))
        .consistent,
    ).toBe(true);
  },
);
integration(
  'three independent consumers handle 50 application duplicates and independent wallets with balanced results',
  async () => {
    const { commandWorker } = await import('../support/command-worker');
    const fixtures = await Promise.all([fixture(), fixture(), fixture()]);
    const workers = Array.from({ length: 3 }, () =>
      commandWorker(database.config, queue, dlq, { COMMAND_TEST_PAUSE: 'committed' }),
    );
    try {
      await Promise.all(workers.map((w) => w.wait('ready')));
      await Promise.all(fixtures.map((f) => send(f.envelope)));
      await Promise.all(workers.map((w) => w.wait('committed')));
      const pids = workers.map((w) => w.child.pid);
      expect(new Set(pids).size).toBe(3);
      for (const w of workers) w.child.send('release');
      await Promise.all(Array.from({ length: 50 }, () => send(fixtures[0]!.envelope)));
      // Flush every distinct transport delivery through the inbox, not FIFO deduplication.
      const { GetQueueAttributesCommand } = await import('@aws-sdk/client-sqs');
      await retryUntil(
        async () => {
          const { Attributes } = await sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: queue,
              AttributeNames: [
                'ApproximateNumberOfMessages',
                'ApproximateNumberOfMessagesNotVisible',
              ],
            }),
          );
          return (
            Number(Attributes!.ApproximateNumberOfMessages) +
            Number(Attributes!.ApproximateNumberOfMessagesNotVisible)
          );
        },
        (n) => n === 0,
        15000,
      );
      for (const { wallet, envelope } of fixtures) {
        const wallets = new Wallets(new WalletRepository(orm), { divergence() {} });
        expect((await wallets.get(wallet.id)).balance.toProps().amount).toBe('80.00');
        expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
        const [{ count }] = await orm.em
          .fork()
          .execute(
            'select count(*)::int as count from messaging.command_inbox where message_id=?',
            [envelope.messageId],
          );
        expect(count).toBe(1);
      }
      console.log(
        'COMMAND_MULTIPROCESS_EVIDENCE',
        JSON.stringify({
          pids,
          transportDeliveries: 53,
          businessOperations: 3,
          balancePerWallet: '80.00',
          reconciled: true,
        }),
      );
    } finally {
      await Promise.all(workers.map((w) => w.stop()));
    }
  },
  25000,
);

integration(
  'production command worker starts independently and processes a message without an HTTP server',
  async () => {
    const { provisionCommandQueues } = await import('../../scripts/provision-commands');
    const name = `bootstrap-commands-${crypto.randomUUID()}.fifo`,
      queues = await provisionCommandQueues(sqs, name);
    const originalQueue = queue;
    queue = queues.queue;
    try {
      const { wallet, envelope } = await fixture();
      await send(envelope);
      const child = Bun.spawn([process.execPath, 'src/bootstrap/command-consumer.ts', '--once'], {
        env: {
          ...process.env,
          DATABASE_URL: database.config.databaseUrl,
          COMMAND_QUEUE_NAME: name,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {
        const [code, out, err] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ code, err }).toEqual({ code: 0, err: '' });
        expect(out).toContain('command_worker_started');
        expect(out).toContain('command_worker_stopped');
        expect(
          (
            await new Wallets(new WalletRepository(orm), { divergence() {} }).get(wallet.id)
          ).balance.toProps().amount,
        ).toBe('80.00');
      } finally {
        clearTimeout(timer);
      }
    } finally {
      queue = originalQueue;
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queues.queue }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queues.dlq }));
    }
  },
  15000,
);
integration(
  'invalid envelopes retain their business identifier and original body in the DLQ diagnostic',
  async () => {
    const { envelope } = await fixture();
    const invalid = { ...envelope, type: 'WrongType' };
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue,
        MessageBody: JSON.stringify(invalid),
        MessageGroupId: envelope.data.walletId,
        MessageDeduplicationId: crypto.randomUUID(),
      }),
    );
    await (await consumer()).runOnce();
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 0 }),
    );
    expect(JSON.parse(Messages![0]!.Body!)).toMatchObject({
      originalMessageId: envelope.messageId,
      reason: 'INVALID_PAYLOAD',
      originalBody: JSON.stringify(invalid),
    });
  },
);
integration(
  'the inbox schema prevents incomplete commits and changing a completed financial association',
  async () => {
    const a = await fixture(),
      b = await fixture(),
      worker = await consumer();
    await send(a.envelope);
    await worker.runOnce();
    await send(b.envelope);
    await worker.runOnce();
    const [second] = await orm.em
      .fork()
      .execute('select transaction_id from messaging.command_inbox where message_id=?', [
        b.envelope.messageId,
      ]);
    await expect(
      orm.em
        .fork()
        .execute('update messaging.command_inbox set transaction_id=? where message_id=?', [
          second.transaction_id,
          a.envelope.messageId,
        ]),
    ).rejects.toThrow();
    await expect(
      orm.em
        .fork()
        .execute(
          'insert into messaging.command_inbox(consumer_name,message_id,request_hash) values(?,?,?)',
          ['test', crypto.randomUUID(), 'a'.repeat(64)],
        ),
    ).rejects.toThrow('Incomplete command inbox');
  },
);
integration(
  'inbox migration is reversible and re-applies deferred completeness constraints',
  async () => {
    await database.owner.getMigrator().down({ migrations: ['Migration202611130007'] });
    expect(
      (await database.owner.em.execute("select to_regclass('messaging.command_inbox') as name"))[0]
        .name,
    ).toBeNull();
    await database.owner.getMigrator().up();
    await expect(
      orm.em
        .fork()
        .execute(
          'insert into messaging.command_inbox(consumer_name,message_id,request_hash) values(?,?,?)',
          ['test', crypto.randomUUID(), 'a'.repeat(64)],
        ),
    ).rejects.toThrow('Incomplete command inbox');
  },
);
integration(
  'business rejection is committed and acked while idempotency and external identity conflicts go to DLQ',
  async () => {
    const { wallet, envelope } = await fixture();
    envelope.data.money.amount = '150.00';
    const worker = await consumer();
    await send(envelope);
    await worker.runOnce();
    const [row] = await orm.em
      .fork()
      .execute(
        'select t.status,t.failure_code from wagering.transactions t join messaging.command_inbox i on i.transaction_id=t.id where i.message_id=?',
        [envelope.messageId],
      );
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    for (const change of [
      { money: { amount: '20.00', currency: 'BRL' } },
      { idempotencyKey: crypto.randomUUID() },
    ]) {
      await send({
        ...envelope,
        messageId: crypto.randomUUID(),
        data: { ...envelope.data, ...change },
      });
      await worker.runOnce();
    }
    const dead = (
      await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: dlq, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
      )
    ).Messages!;
    expect(dead.map((m) => JSON.parse(m.Body!).reason).sort()).toEqual([
      'EXTERNAL_TRANSACTION_CONFLICT',
      'IDEMPOTENCY_CONFLICT',
    ]);
    expect(
      (
        await new Wallets(new WalletRepository(orm), { divergence() {} }).get(wallet.id)
      ).balance.toProps().amount,
    ).toBe('100.00');
  },
);
integration(
  'SIGTERM drains a finishing transaction and acknowledges its committed result',
  async () => {
    const { commandWorker } = await import('../support/command-worker');
    const { wallet, envelope } = await fixture(),
      locker = database.owner.em.fork();
    await locker.begin();
    await locker.execute('select id from wagering.wallets where id=? for update', [wallet.id]);
    await send(envelope);
    const worker = commandWorker(database.config, queue, dlq, { COMMAND_TEST_DRAIN: '2000' });
    try {
      await worker.wait('ready');
      await retryUntil(
        () =>
          database.owner.em
            .fork()
            .execute<
              { waiting: boolean }[]
            >(`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock') as waiting`),
        (rows) => rows[0]!.waiting,
      );
      const stopping = worker.stop();
      await locker.rollback();
      expect(await stopping).toBe(0);
      expect(
        (
          await new Wallets(new WalletRepository(orm), { divergence() {} }).get(wallet.id)
        ).balance.toProps().amount,
      ).toBe('80.00');
      expect(
        (await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue, WaitTimeSeconds: 0 })))
          .Messages ?? [],
      ).toHaveLength(0);
    } finally {
      if (locker.isInTransaction()) await locker.rollback();
      await worker.stop('SIGKILL');
    }
  },
  10000,
);

integration(
  'HTTP and SQS race in three independent processes and share the same financial acceptance',
  async () => {
    const { apiProcess } = await import('../support/api-cluster');
    const { commandWorker } = await import('../support/command-worker');
    const { providerToken } = await import('../support/keycloak');
    const api = await apiProcess(database.config, `issue-7-http-${crypto.randomUUID()}`),
      workers = [
        commandWorker(database.config, queue, dlq),
        commandWorker(database.config, queue, dlq),
      ];
    try {
      await Promise.all(workers.map((w) => w.wait('ready')));
      const token = await providerToken('a');
      const fixtures = await Promise.all(Array.from({ length: 6 }, () => fixture()));
      await Promise.all(
        fixtures.flatMap(({ envelope }) => {
          const { idempotencyKey, ...body } = envelope.data;
          return [
            send(envelope),
            fetch(`${api.base}/wagering/transactions`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': idempotencyKey,
              },
              body: JSON.stringify(body),
            }).then(async (response) => {
              expect(response.status).toBe(200);
              expect(await response.json()).toMatchObject({
                status: 'PROCESSED',
                balance: { amount: '80.00', currency: 'BRL' },
              });
            }),
          ];
        }),
      );
      for (const { wallet, envelope } of fixtures) {
        await retryUntil(
          () =>
            orm.em
              .fork()
              .execute('select * from messaging.command_inbox where message_id=?', [
                envelope.messageId,
              ]),
          (rows) => rows.length === 1,
        );
        expect(
          (
            await new Wallets(new WalletRepository(orm), { divergence() {} }).get(wallet.id)
          ).balance.toProps().amount,
        ).toBe('80.00');
        expect(
          (await new Wallets(new WalletRepository(orm), { divergence() {} }).reconcile(wallet.id))
            .consistent,
        ).toBe(true);
      }
      expect(new Set([api.pid, ...workers.map((w) => w.child.pid)]).size).toBe(3);
    } finally {
      await Promise.all(workers.map((w) => w.stop()));
      await api.stop();
    }
  },
  15000,
);
integration(
  'SIGTERM remains bounded when a real SQS visibility-renewal request stalls',
  async () => {
    const { SQSClient } = await import('@aws-sdk/client-sqs');
    const { CommandConsumer } = await import('../../src/messaging/commands/command-consumer');
    const { wallet, envelope } = await fixture(),
      locker = database.owner.em.fork();
    await locker.begin();
    await locker.execute('select id from wagering.wallets where id=? for update', [wallet.id]);
    await send(envelope);
    let sawRenewal!: () => void, release!: () => void;
    const renewing = new Promise<void>((resolve) => {
        sawRenewal = resolve;
      }),
      stalled = new Promise<void>((resolve) => {
        release = resolve;
      });
    const proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = await request.text(),
          target = request.headers.get('x-amz-target') ?? '';
        if (target.endsWith('.ChangeMessageVisibility') && JSON.parse(body).VisibilityTimeout > 0) {
          sawRenewal();
          await stalled;
        }
        const headers = new Headers(request.headers);
        headers.delete('host');
        headers.delete('content-length');
        return fetch(database.config.sqsEndpoint, { method: request.method, headers, body });
      },
    });
    const slow = new SQSClient({
      region: database.config.awsRegion,
      endpoint: proxy.url.toString(),
      useQueueUrlAsEndpoint: false,
      maxAttempts: 1,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const worker = new CommandConsumer(
      orm,
      slow,
      { ...database.config, financialLockTimeoutMs: 10000, financialStatementTimeoutMs: 10000 },
      {
        queueUrl: queue,
        dlqUrl: dlq,
        visibilitySeconds: 1,
        callTimeoutMs: 2000,
        retryBaseMs: 1,
        retryMaxMs: 1,
        waitSeconds: 0,
        drainMs: 100,
      },
    );
    let running: Promise<number> | undefined;
    try {
      running = worker.runOnce();
      await Promise.race([
        renewing,
        Bun.sleep(3000).then(() => {
          throw new Error('No visibility renewal');
        }),
      ]);
      const started = Date.now();
      worker.stop();
      await running;
      expect(Date.now() - started).toBeLessThan(1500);
      expect(
        await orm.em
          .fork()
          .execute('select * from messaging.command_inbox where message_id=?', [
            envelope.messageId,
          ]),
      ).toHaveLength(0);
    } finally {
      release();
      await running;
      slow.destroy();
      await proxy.stop(true);
      if (locker.isInTransaction()) await locker.rollback();
    }
  },
  10000,
);
