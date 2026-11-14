import type { WagerCommand } from '../../src/modules/wagering/domain/wager-command';
import type { MoneyProps } from '../../src/shared/domain/money';
import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test';
import { DeleteQueueCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadCommandConfig } from '../../src/messaging/commands/config';
import { provisionCommandQueues } from '../../scripts/provision-commands';
import { createSubmission } from '../../src/modules/wagering/infrastructure/create-submission';
import { WageringRepository } from '../../src/modules/wagering/infrastructure/persistence/wagering-repository';
import { disposableDatabase } from './database';
import { openDatabase } from '../../src/config/orm';
import { createSqsClient } from '../../src/config/sqs';
import { Wallets } from '../../src/modules/wallets/application/wallets';
import { WalletRepository } from '../../src/modules/wallets/infrastructure/persistence/wallet-repository';
import { Money } from '../../src/shared/domain/money';
export type CommandData = Omit<WagerCommand, 'money'> & {
  money: MoneyProps;
  idempotencyKey: string;
};
export interface CommandEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: CommandData;
}
export function commandEnvelope(
  data: CommandData,
  messageId: string = crypto.randomUUID(),
): CommandEnvelope {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data,
  };
}
export function commandSuite() {
  const state = {} as {
    database: Awaited<ReturnType<typeof disposableDatabase>>;
    orm: Awaited<ReturnType<typeof openDatabase>>;
    sqs: ReturnType<typeof createSqsClient>;
    queue: string;
    dlq: string;
  };
  beforeAll(async () => {
    if (process.env.INTEGRATION !== '1') return;
    state.database = await disposableDatabase();
    state.orm = await openDatabase(state.database.config);
    state.sqs = createSqsClient(state.database.config);
  });
  beforeEach(async () => {
    if (process.env.INTEGRATION !== '1') return;
    const queues = await provisionCommandQueues(state.sqs, {
      ...loadCommandConfig(),
      queueName: 'commands-' + crypto.randomUUID() + '.fifo',
    });
    Object.assign(state, queues);
  });
  afterEach(async () => {
    if (state.sqs) {
      await state.sqs.send(new DeleteQueueCommand({ QueueUrl: state.queue }));
      await state.sqs.send(new DeleteQueueCommand({ QueueUrl: state.dlq }));
    }
  });
  afterAll(async () => {
    state.sqs?.destroy();
    await state.orm?.close(true);
    await state.database?.close();
  });
  async function fixture() {
    const wallet = await new Wallets(new WalletRepository(state.orm), { divergence() {} }).create(
      { playerId: crypto.randomUUID(), initialBalance: Money.create('100.00', 'BRL') },
      { actorId: crypto.randomUUID(), correlationId: crypto.randomUUID() },
    );
    return {
      wallet,
      envelope: commandEnvelope({
        providerId: 'provider-a',
        externalTransactionId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'r',
        gameId: 'g',
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' },
      }),
    };
  }
  // Malformed-envelope tests deliberately send invalid business fields over real SQS.
  async function send<T extends { data: { walletId: string } }>(envelope: T) {
    await state.sqs.send(
      new SendMessageCommand({
        QueueUrl: state.queue,
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
    observer: import('../../src/messaging/commands/command-consumer').CommandConsumerObserver = {},
  ) {
    const { CommandConsumer } = await import('../../src/messaging/commands/command-consumer');
    return new CommandConsumer(
      createSubmission(
        new WageringRepository(state.orm, state.database.config),
        state.database.config,
      ),
      state.sqs,
      {
        financialDeadlineMs: state.database.config.financialDeadlineMs,
        queueUrl: state.queue,
        dlqUrl: state.dlq,
        visibilitySeconds: 30,
        callTimeoutMs: 5000,
        retryBaseMs: 1000,
        retryMaxMs: 30000,
        waitSeconds: 0,
        drainMs: 20000,
        ...overrides,
      },
      observer,
    );
  }

  return { state, fixture, send, consumer };
}
export { retryUntil } from './poll';
