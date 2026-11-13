import { expect, test } from 'bun:test';
import { commandSuite, retryUntil } from '../support/command-fixture';
import { loadCommandConfig } from '../../src/messaging/commands/config';
import { provisionCommandQueues } from '../../scripts/provision-commands';
import { createSubmission } from '../../src/modules/wagering/infrastructure/create-submission';
import { WageringRepository } from '../../src/modules/wagering/infrastructure/persistence/wagering-repository';
import { ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Wallets } from '../../src/modules/wallets/application/wallets';
import { WalletRepository } from '../../src/modules/wallets/infrastructure/persistence/wallet-repository';
const integration = process.env.INTEGRATION === '1' ? test : test.skip;
const { state, fixture, send, consumer } = commandSuite();
integration(
  'a divergent business messageId goes to DLQ without overwriting the inbox or debiting again',
  async () => {
    const { wallet, envelope } = await fixture(),
      worker = await consumer();
    await send(envelope);
    await worker.runOnce();
    await send({
      ...envelope,
      data: {
        ...envelope.data,
        idempotencyKey: crypto.randomUUID(),
        externalTransactionId: crypto.randomUUID(),
        money: { amount: '30.00', currency: 'BRL' },
      },
    });
    await worker.runOnce();
    const dead = (
      await state.sqs.send(new ReceiveMessageCommand({ QueueUrl: state.dlq, WaitTimeSeconds: 0 }))
    ).Messages!;
    expect(dead).toHaveLength(1);
    expect(dead[0]!.MessageAttributes).toBeUndefined();
    const diagnostic = JSON.parse(dead[0]!.Body!);
    expect(diagnostic).toMatchObject({
      reason: 'INBOX_CONFLICT',
      originalMessageId: envelope.messageId,
    });
    expect(JSON.parse(diagnostic.originalBody).data.money.amount).toBe('30.00');
    const result = await new Wallets(new WalletRepository(state.orm), { divergence() {} }).get(
      wallet.id,
    );
    expect(result.balance.toProps().amount).toBe('80.00');
    const { DeleteMessageCommand } = await import('@aws-sdk/client-sqs');
    await state.sqs.send(
      new DeleteMessageCommand({ QueueUrl: state.dlq, ReceiptHandle: dead[0]!.ReceiptHandle! }),
    );
  },
);

integration(
  'a missing DLQ retains the source and recovers without losing a poison message',
  async () => {
    const { CommandConsumer } = await import('../../src/messaging/commands/command-consumer');
    const { wallet, envelope } = await fixture();
    envelope.data.providerId = 'unknown';
    await send(envelope);
    const worker = new CommandConsumer(
      createSubmission(
        new WageringRepository(state.orm, state.database.config),
        state.database.config,
      ),
      state.sqs,
      {
        financialDeadlineMs: state.database.config.financialDeadlineMs,
        queueUrl: state.queue,
        dlqUrl: state.queue.replace(/[^/]+$/, 'missing-dlq.fifo'),
        visibilitySeconds: 30,
        callTimeoutMs: 500,
        retryBaseMs: 1,
        retryMaxMs: 1,
        waitSeconds: 0,
        drainMs: 100,
      },
    );
    await worker.runOnce();
    const healthy = await consumer();
    await retryUntil(
      () => healthy.runOnce(),
      (n) => n === 1,
    );
    const { Messages } = await state.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: state.dlq, WaitTimeSeconds: 0 }),
    );
    expect(JSON.parse(Messages![0]!.Body!)).toMatchObject({
      reason: 'UNKNOWN_PROVIDER',
      originalMessageId: envelope.messageId,
    });
    expect(
      (
        await new Wallets(new WalletRepository(state.orm), { divergence() {} }).get(wallet.id)
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
    const first = commandWorker(state.database.config, state.queue, state.dlq, {
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
      const { Messages } = await state.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: state.dlq,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
        }),
      );
      expect(Messages).toHaveLength(1);
      expect(JSON.parse(Messages![0]!.Body!).originalMessageId).toBe(envelope.messageId);
      expect(
        (
          await state.sqs.send(
            new ReceiveMessageCommand({ QueueUrl: state.queue, WaitTimeSeconds: 0 }),
          )
        ).Messages ?? [],
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
    await provisionCommandQueues(state.sqs, {
      ...loadCommandConfig(),
      queueName: state.queue.split('/').at(-1)!,
      visibilitySeconds: 1,
    });
    const { wallet, envelope } = await fixture();
    await send(envelope);
    await state.database.owner.em
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
            (
              await state.sqs.send(
                new ReceiveMessageCommand({ QueueUrl: state.dlq, WaitTimeSeconds: 0 }),
              )
            ).Messages ?? []
          );
        },
        (messages) => messages.length > 0,
      );
      expect(JSON.parse(dead[0]!.Body!).messageId).toBe(envelope.messageId);
      expect(
        (
          await new Wallets(new WalletRepository(state.orm), { divergence() {} }).get(wallet.id)
        ).balance.toProps().amount,
      ).toBe('100.00');
      expect(
        await state.orm.em
          .fork()
          .execute('select * from wagering.transactions where external_transaction_id=?', [
            envelope.data.externalTransactionId,
          ]),
      ).toHaveLength(0);
    } finally {
      await state.database.owner.em.execute(
        'drop trigger fail_retry_test on messaging.command_inbox;drop function messaging.fail_retry_test();',
      );
    }
  },
  20000,
);

integration(
  'invalid envelopes retain their business identifier and original body in the DLQ diagnostic',
  async () => {
    const { envelope } = await fixture();
    const invalid = { ...envelope, type: 'WrongType' };
    await state.sqs.send(
      new SendMessageCommand({
        QueueUrl: state.queue,
        MessageBody: JSON.stringify(invalid),
        MessageGroupId: envelope.data.walletId,
        MessageDeduplicationId: crypto.randomUUID(),
      }),
    );
    await (await consumer()).runOnce();
    const { Messages } = await state.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: state.dlq, WaitTimeSeconds: 0 }),
    );
    expect(JSON.parse(Messages![0]!.Body!)).toMatchObject({
      originalMessageId: envelope.messageId,
      reason: 'INVALID_PAYLOAD',
      originalBody: JSON.stringify(invalid),
    });
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
    const [row] = await state.orm.em
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
      await state.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: state.dlq,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
        }),
      )
    ).Messages!;
    expect(dead.map((m) => JSON.parse(m.Body!).reason).sort()).toEqual([
      'EXTERNAL_TRANSACTION_CONFLICT',
      'IDEMPOTENCY_CONFLICT',
    ]);
    expect(
      (
        await new Wallets(new WalletRepository(state.orm), { divergence() {} }).get(wallet.id)
      ).balance.toProps().amount,
    ).toBe('100.00');
  },
);
