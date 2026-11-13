import { expect, test } from 'bun:test';
import { commandSuite, retryUntil } from '../support/command-fixture';
import { loadCommandConfig } from '../../src/messaging/commands/config';
import { provisionCommandQueues } from '../../scripts/provision-commands';
import { DeleteQueueCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { Wallets } from '../../src/modules/wallets/application/wallets';
import { WalletRepository } from '../../src/modules/wallets/infrastructure/persistence/wallet-repository';
const integration = process.env.INTEGRATION === '1' ? test : test.skip;
const { state, fixture, send, consumer } = commandSuite();
integration(
  'SQS duplicates beyond FIFO deduplication debit once and commit one inbox with the financial result',
  async () => {
    const { wallet, envelope } = await fixture();
    const worker = await consumer();
    await send(envelope);
    expect(await worker.runOnce()).toBe(1);
    await send({ ...envelope, occurredAt: '2026-01-01T00:00:00.000Z' });
    expect(await worker.runOnce()).toBe(1);
    const result = await new Wallets(new WalletRepository(state.orm), { divergence() {} }).get(
      wallet.id,
    );
    expect(result.balance.toProps()).toEqual({ amount: '80.00', currency: 'BRL' });
    expect(result.version).toBe(2);
    const rows = await state.orm.em
      .fork()
      .execute('select * from messaging.command_inbox where message_id=?', [envelope.messageId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].transaction_id).toBeString();
    expect(
      (
        await state.sqs.send(
          new ReceiveMessageCommand({ QueueUrl: state.queue, WaitTimeSeconds: 0 }),
        )
      ).Messages ?? [],
    ).toHaveLength(0);
  },
);

integration(
  'provisioning is repeatable and installs maxReceiveCount=5 on the required command queue',
  async () => {
    const { provisionCommandQueues } = await import('../../scripts/provision-commands');
    const { GetQueueAttributesCommand } = await import('@aws-sdk/client-sqs');
    const name = `provision-commands-${crypto.randomUUID()}.fifo`;
    const queues = await provisionCommandQueues(state.sqs, {
      ...loadCommandConfig(),
      queueName: name,
    });
    try {
      expect(
        await provisionCommandQueues(state.sqs, { ...loadCommandConfig(), queueName: name }),
      ).toEqual(queues);
      const { Attributes } = await state.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queues.queue,
          AttributeNames: ['RedrivePolicy', 'VisibilityTimeout'],
        }),
      );
      expect(JSON.parse(Attributes!.RedrivePolicy!).maxReceiveCount).toBe(5);
      expect(Attributes!.VisibilityTimeout).toBe('30');
    } finally {
      await state.sqs.send(new DeleteQueueCommand({ QueueUrl: queues.queue }));
      await state.sqs.send(new DeleteQueueCommand({ QueueUrl: queues.dlq }));
    }
  },
);

integration(
  'HTTP then SQS and SQS then HTTP preserve the original receipt and financial idempotency',
  async () => {
    const { createApplication } = await import('../../src/bootstrap/application');
    const { providerToken } = await import('../support/keycloak');
    const app = await createApplication(state.database.config);
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
            await new Wallets(new WalletRepository(state.orm), { divergence() {} }).get(wallet.id)
          ).balance.toProps().amount,
        ).toBe('80.00');
        const [{ count }] = await state.orm.em
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
  'a failed inbox insert rolls back wallet, ledger, receipt and outbox before retry',
  async () => {
    const { wallet, envelope } = await fixture(),
      worker = await consumer();
    await state.database.owner.em
      .execute(`create function messaging.fail_inbox_test() returns trigger language plpgsql as $$ begin raise exception 'injected inbox failure'; end $$;
 create trigger fail_inbox_test before insert on messaging.command_inbox for each row execute function messaging.fail_inbox_test();`);
    try {
      await send(envelope);
      await worker.runOnce();
      expect(
        (
          await new Wallets(new WalletRepository(state.orm), { divergence() {} }).get(wallet.id)
        ).balance.toProps().amount,
      ).toBe('100.00');
      expect(
        await state.orm.em
          .fork()
          .execute('select * from messaging.command_inbox where message_id=?', [
            envelope.messageId,
          ]),
      ).toHaveLength(0);
      expect(
        await state.orm.em
          .fork()
          .execute('select * from wagering.transactions where external_transaction_id=?', [
            envelope.data.externalTransactionId,
          ]),
      ).toHaveLength(0);
    } finally {
      await state.database.owner.em.execute(
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
        await new Wallets(new WalletRepository(state.orm), { divergence() {} }).get(wallet.id)
      ).balance.toProps().amount,
    ).toBe('80.00');
  },
);
