import { lockWalletRows, waitForWalletLock } from '../support/sql-barrier';
import { drainQueue } from '../support/queue';
import { expect, test } from 'bun:test';
import { commandSuite, retryUntil } from '../support/command-fixture';
import { loadCommandConfig } from '../../src/messaging/commands/config';
import { provisionCommandQueues } from '../../scripts/provision-commands';
import { createSubmission } from '../../src/modules/wagering/infrastructure/create-submission';
import { WageringRepository } from '../../src/modules/wagering/infrastructure/persistence/wagering-repository';
import { DeleteQueueCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { Wallets } from '../../src/modules/wallets/application/wallets';
import { WalletRepository } from '../../src/modules/wallets/infrastructure/persistence/wallet-repository';
const integration = process.env.INTEGRATION === '1' ? test : test.skip;
const { state, fixture, send, consumer } = commandSuite();
integration(
  'SIGKILL after commit before ack redelivers to another process without a second debit',
  async () => {
    const { commandWorker } = await import('../support/command-worker');
    const { wallet, envelope } = await fixture();
    await send(envelope);
    const first = commandWorker(state.database.config, state.queue, state.dlq, {
      COMMAND_TEST_PAUSE: 'committed',
    });
    try {
      const committed = await first.wait('committed');
      expect(committed.messageId).toBe(envelope.messageId);
      await first.stop('SIGKILL');
      const second = commandWorker(state.database.config, state.queue, state.dlq);
      try {
        await second.wait('committed');
        expect(second.child.pid).not.toBe(first.child.pid);
      } finally {
        await second.stop();
      }
      const w = await new Wallets(new WalletRepository(state.orm), { divergence() {} }).get(
        wallet.id,
      );
      expect(w.balance.toProps().amount).toBe('80.00');
      expect(w.version).toBe(2);
      const [{ count }] = await state.orm.em
        .fork()
        .execute('select count(*)::int as count from messaging.command_inbox where message_id=?', [
          envelope.messageId,
        ]);
      expect(count).toBe(1);
      expect(
        (
          await new Wallets(new WalletRepository(state.orm), { divergence() {} }).reconcile(
            wallet.id,
          )
        ).consistent,
      ).toBe(true);
    } finally {
      await first.stop('SIGKILL');
    }
  },
  15000,
);

integration(
  'SIGTERM cancels SQL and rolls back before returning visibility, while heartbeats protect active work',
  async () => {
    const { commandWorker } = await import('../support/command-worker');
    const { wallet, envelope } = await fixture();
    const locker = state.database.owner.em.fork();
    await locker.begin();
    await lockWalletRows(locker, wallet.id);
    await send(envelope);
    const worker = commandWorker(state.database.config, state.queue, state.dlq, {
      COMMAND_TEST_DRAIN: '100',
      FINANCIAL_LOCK_TIMEOUT_MS: '10000',
      FINANCIAL_STATEMENT_TIMEOUT_MS: '10000',
    });
    try {
      await worker.wait('ready');
      await waitForWalletLock(state.database.owner);
      // Observe several visibility-renewal cycles while a real PostgreSQL lock keeps work in flight.
      const end = Date.now() + 1500;
      do {
        expect(
          (
            await state.sqs.send(
              new ReceiveMessageCommand({ QueueUrl: state.queue, WaitTimeSeconds: 0 }),
            )
          ).Messages ?? [],
        ).toHaveLength(0);
        await Bun.sleep(100);
      } while (Date.now() < end);
      const started = Date.now();
      expect(await worker.stop()).toBe(0);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(
        await state.orm.em
          .fork()
          .execute('select * from messaging.command_inbox where message_id=?', [
            envelope.messageId,
          ]),
      ).toHaveLength(0);
      await locker.rollback();
      expect(await (await consumer()).runOnce()).toBe(1);
      expect(
        (
          await new Wallets(new WalletRepository(state.orm), { divergence() {} }).get(wallet.id)
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
  'three independent consumers handle 50 application duplicates and independent wallets with balanced results',
  async () => {
    const { commandWorker } = await import('../support/command-worker');
    const fixtures = await Promise.all([fixture(), fixture(), fixture()]);
    const workers = Array.from({ length: 3 }, () =>
      commandWorker(state.database.config, state.queue, state.dlq, {
        COMMAND_TEST_PAUSE: 'committed',
      }),
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
      await drainQueue(state.sqs, state.queue);
      for (const { wallet, envelope } of fixtures) {
        const wallets = new Wallets(new WalletRepository(state.orm), { divergence() {} });
        expect((await wallets.get(wallet.id)).balance.toProps().amount).toBe('80.00');
        expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
        const [{ count }] = await state.orm.em
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
      queues = await provisionCommandQueues(state.sqs, { ...loadCommandConfig(), queueName: name });
    const originalQueue = state.queue;
    state.queue = queues.queue;
    try {
      const { wallet, envelope } = await fixture();
      await send(envelope);
      const child = Bun.spawn([process.execPath, 'src/bootstrap/command-consumer.ts', '--once'], {
        env: {
          ...process.env,
          DATABASE_URL: state.database.config.databaseUrl,
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
        expect(out).toContain('worker_started');
        expect(out).toContain('worker_stopped');
        expect(
          (
            await new Wallets(new WalletRepository(state.orm), { divergence() {} }).get(wallet.id)
          ).balance.toProps().amount,
        ).toBe('80.00');
      } finally {
        clearTimeout(timer);
      }
    } finally {
      state.queue = originalQueue;
      await state.sqs.send(new DeleteQueueCommand({ QueueUrl: queues.queue }));
      await state.sqs.send(new DeleteQueueCommand({ QueueUrl: queues.dlq }));
    }
  },
  15000,
);

integration(
  'SIGTERM drains a finishing transaction and acknowledges its committed result',
  async () => {
    const { commandWorker } = await import('../support/command-worker');
    const { wallet, envelope } = await fixture(),
      locker = state.database.owner.em.fork();
    await locker.begin();
    await lockWalletRows(locker, wallet.id);
    await send(envelope);
    const worker = commandWorker(state.database.config, state.queue, state.dlq, {
      COMMAND_TEST_DRAIN: '2000',
    });
    try {
      await worker.wait('ready');
      await waitForWalletLock(state.database.owner);
      const stopping = worker.stop();
      await locker.rollback();
      expect(await stopping).toBe(0);
      expect(
        (
          await new Wallets(new WalletRepository(state.orm), { divergence() {} }).get(wallet.id)
        ).balance.toProps().amount,
      ).toBe('80.00');
      expect(
        (
          await state.sqs.send(
            new ReceiveMessageCommand({ QueueUrl: state.queue, WaitTimeSeconds: 0 }),
          )
        ).Messages ?? [],
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
    const api = await apiProcess(state.database.config, `issue-7-http-${crypto.randomUUID()}`),
      workers = [
        commandWorker(state.database.config, state.queue, state.dlq),
        commandWorker(state.database.config, state.queue, state.dlq),
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
            state.orm.em
              .fork()
              .execute('select * from messaging.command_inbox where message_id=?', [
                envelope.messageId,
              ]),
          (rows) => rows.length === 1,
        );
        expect(
          (
            await new Wallets(new WalletRepository(state.orm), { divergence() {} }).get(wallet.id)
          ).balance.toProps().amount,
        ).toBe('80.00');
        expect(
          (
            await new Wallets(new WalletRepository(state.orm), { divergence() {} }).reconcile(
              wallet.id,
            )
          ).consistent,
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
      locker = state.database.owner.em.fork();
    await locker.begin();
    await lockWalletRows(locker, wallet.id);
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
        return fetch(state.database.config.sqsEndpoint, { method: request.method, headers, body });
      },
    });
    const slow = new SQSClient({
      region: state.database.config.awsRegion,
      endpoint: proxy.url.toString(),
      useQueueUrlAsEndpoint: false,
      maxAttempts: 1,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const worker = new CommandConsumer(
      createSubmission(
        new WageringRepository(state.orm, {
          ...state.database.config,
          financialLockTimeoutMs: 10000,
          financialStatementTimeoutMs: 10000,
        }),
        state.database.config,
      ),
      slow,
      {
        queueUrl: state.queue,
        dlqUrl: state.dlq,
        visibilitySeconds: 1,
        financialDeadlineMs: state.database.config.financialDeadlineMs,
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
        await state.orm.em
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

integration(
  'worker logs correlate financial commits and dead letters with known transaction, wallet and provider identifiers',
  async () => {
    const { commandWorker } = await import('../support/command-worker');
    const { wallet, envelope } = await fixture();
    await send(envelope);
    const worker = commandWorker(state.database.config, state.queue, state.dlq);
    try {
      await worker.wait('committed');
      await worker.stop();
      const logs = (await worker.logs)
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(logs.find((log) => log.event === 'command_committed')).toMatchObject({
        correlationId: envelope.messageId,
        messageId: envelope.messageId,
        providerId: 'provider-a',
        walletId: wallet.id,
        transactionId: expect.any(String),
      });
    } finally {
      await worker.stop('SIGKILL');
    }
    const invalid = {
      ...envelope,
      messageId: crypto.randomUUID(),
      data: { ...envelope.data, providerId: 'unknown' },
    };
    await send(invalid);
    const poison = commandWorker(state.database.config, state.queue, state.dlq);
    try {
      await poison.wait('deadLetterSent');
      await poison.stop();
      const logs = (await poison.logs)
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(logs.find((log) => log.event === 'command_dead_lettered')).toMatchObject({
        correlationId: invalid.messageId,
        providerId: 'unknown',
        walletId: wallet.id,
        reason: 'UNKNOWN_PROVIDER',
      });
    } finally {
      await poison.stop('SIGKILL');
    }
  },
);

integration(
  'a failed post-commit ack retries the real SQS delivery without sending it to DLQ',
  async () => {
    const { SQSClient } = await import('@aws-sdk/client-sqs');
    const { CommandConsumer } = await import('../../src/messaging/commands/command-consumer');
    const { wallet, envelope } = await fixture();
    await send(envelope);
    let failed = false;
    const proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = await request.text();
        if ((request.headers.get('x-amz-target') ?? '').endsWith('.DeleteMessage') && !failed) {
          failed = true;
          return Response.json(
            { __type: 'ServiceUnavailable', message: 'injected ack unavailable' },
            { status: 503 },
          );
        }
        const headers = new Headers(request.headers);
        headers.delete('host');
        headers.delete('content-length');
        return fetch(state.database.config.sqsEndpoint, { method: request.method, headers, body });
      },
    });
    const transport = new SQSClient({
      region: state.database.config.awsRegion,
      endpoint: proxy.url.toString(),
      useQueueUrlAsEndpoint: false,
      maxAttempts: 1,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const worker = new CommandConsumer(
      createSubmission(
        new WageringRepository(state.orm, state.database.config),
        state.database.config,
      ),
      transport,
      {
        ...loadCommandConfig(),
        financialDeadlineMs: state.database.config.financialDeadlineMs,
        queueUrl: state.queue,
        dlqUrl: state.dlq,
        retryBaseMs: 1,
        retryMaxMs: 1,
        waitSeconds: 0,
      },
    );
    try {
      await worker.runOnce();
      expect(failed).toBe(true);
      await retryUntil(
        () => worker.runOnce(),
        (n) => n === 1,
      );
      expect(
        (
          await new Wallets(new WalletRepository(state.orm), { divergence() {} }).get(wallet.id)
        ).balance.toProps().amount,
      ).toBe('80.00');
      expect(
        (
          await state.sqs.send(
            new ReceiveMessageCommand({ QueueUrl: state.dlq, WaitTimeSeconds: 0 }),
          )
        ).Messages ?? [],
      ).toHaveLength(0);
    } finally {
      transport.destroy();
      await proxy.stop(true);
    }
  },
);
