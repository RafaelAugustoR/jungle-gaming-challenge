import { expect } from 'bun:test';
import Decimal from 'decimal.js';
import { DeleteQueueCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { disposableDatabase } from './database';
import { openDatabase } from '../../src/config/orm';
import { createSqsClient } from '../../src/config/sqs';
import { apiProcess } from './api-cluster';
import { commandWorker } from './command-worker';
import { publisherWorker } from './publisher-worker';
import { referenceProcess } from './reference-process';
import { humanToken, providerToken } from './keycloak';
import { commandEnvelope, type CommandData } from './command-fixture';
import { retryUntil } from './poll';
import { drainQueue } from './queue';
import { holdWallets, waitForWalletLock } from './sql-barrier';
import { spawnStaged } from './spawn-staged';
import { loadCommandConfig } from '../../src/messaging/commands/config';
import { provisionCommandQueues } from '../../scripts/provision-commands';
import { provisionEventQueues } from '../../scripts/provision-events';
import { CommandConsumer } from '../../src/messaging/commands/command-consumer';
import { createSubmission } from '../../src/modules/wagering/infrastructure/create-submission';
import { WageringRepository } from '../../src/modules/wagering/infrastructure/persistence/wagering-repository';

export interface WalletFixture {
  id: string;
  playerId: string;
}
interface RecoveryEvidence {
  at: string;
  stages: string[];
  apiPids: number[];
  processPids: number[];
  final?: Record<string, unknown>;
}
export const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

export async function recoveryHarness() {
  const database = await disposableDatabase();
  const orm = await openDatabase(database.config);
  const sqs = createSqsClient(database.config);
  const apis: Awaited<ReturnType<typeof apiProcess>>[] = [];
  const workers: ReturnType<typeof commandWorker>[] = [];
  const publishers: ReturnType<typeof publisherWorker>[] = [];
  const references: Awaited<ReturnType<typeof referenceProcess>>[] = [];
  const standalone: ReturnType<typeof spawnStaged>[] = [];
  const queues: string[] = [];
  const expected = new Map<string, string>();
  // Expected facts come from the test's explicit business outcomes, never database results.
  const facts = { events: 0, journalEntries: 0, pairedAmount: new Decimal(0) };
  const evidence: RecoveryEvidence = {
    at: new Date().toISOString(),
    stages: [],
    apiPids: [],
    processPids: [],
  };
  const sql = (query: string, params: unknown[] = []) =>
    database.owner.em.fork().execute(query, params);
  async function stopWorkers() {
    await Promise.allSettled([
      ...workers.splice(0).map((w) => w.stop('SIGKILL')),
      ...publishers.splice(0).map((p) => p.kill()),
      ...references.splice(0).map((r) => r.kill()),
      ...standalone.splice(0).map((p) => p.stop('SIGKILL')),
    ]);
  }
  async function close() {
    await stopWorkers();
    await Promise.allSettled(apis.map((a) => a.stop()));
    await Promise.allSettled(
      queues.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))),
    );
    sqs.destroy();
    await orm.close(true);
    await database.close();
  }
  try {
    const commands = await provisionCommandQueues(sqs, {
      ...loadCommandConfig(),
      queueName: `recovery-${crypto.randomUUID()}.fifo`,
    });
    queues.push(commands.queue, commands.dlq);
    const events = await provisionEventQueues(sqs, `recovery-events-${crypto.randomUUID()}.fifo`);
    queues.push(events.queue, events.dlq);
    for (let i = 0; i < 3; i++) apis.push(await apiProcess(database.config, `recovery-api-${i}`));
    evidence.apiPids = apis.map((a) => a.pid);
    evidence.processPids.push(...evidence.apiPids);
    expect(new Set(evidence.apiPids).size).toBe(3);
    const [demo, provider] = await Promise.all([humanToken('demo-operator'), providerToken('a')]);
    async function wallet() {
      const response = await fetch(`${apis[0]!.base}/wallets`, {
        method: 'POST',
        headers: authHeaders(demo),
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        }),
      });
      expect(response.status).toBe(201);
      const value = (await response.json()) as WalletFixture;
      expected.set(value.id, '100.00');
      facts.events += 2; // WalletBalanceChanged + WagerTransactionProcessed of the OPENING
      facts.journalEntries++;
      facts.pairedAmount = facts.pairedAmount.plus('100.00');
      return value;
    }
    function command(w: WalletFixture, amount = '80.00'): CommandData {
      return {
        providerId: 'provider-a',
        externalTransactionId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        walletId: w.id,
        playerId: w.playerId,
        roundId: 'recovery-round',
        gameId: 'recovery-game',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      };
    }
    async function http(command: CommandData, index = 0) {
      const { idempotencyKey, ...body } = command;
      const response = await fetch(`${apis[index]!.base}/wagering/transactions`, {
        method: 'POST',
        headers: { ...authHeaders(provider), 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }
    async function send(data: CommandData, messageId = crypto.randomUUID()) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: commands.queue,
          MessageBody: JSON.stringify(commandEnvelope(data, messageId)),
          MessageGroupId: data.walletId,
          MessageDeduplicationId: crypto.randomUUID(),
        }),
      );
      return messageId;
    }
    function expectMovement(w: WalletFixture, balance: string, amount: string) {
      expected.set(w.id, balance);
      facts.events += 2;
      facts.journalEntries++;
      facts.pairedAmount = facts.pairedAmount.plus(amount);
    }
    function expectRejection() {
      facts.events++;
    }
    function expectPendingReference() {
      facts.events++;
    }
    function startWorker(
      extra: Record<string, string> = {},
      databaseUrl = database.config.databaseUrl,
    ) {
      const worker = commandWorker(
        { ...database.config, databaseUrl },
        commands.queue,
        commands.dlq,
        extra,
      );
      workers.push(worker);
      evidence.processPids.push(worker.pid);
      return worker;
    }
    function startPublisher(
      config = database.config,
      queue = events.queue,
      options: Parameters<typeof publisherWorker>[2] = {},
    ) {
      const worker = publisherWorker(config, queue, options);
      publishers.push(worker);
      evidence.processPids.push(worker.pid);
      return worker;
    }
    async function startReferences() {
      const worker = await referenceProcess(database.config);
      references.push(worker);
      evidence.processPids.push(worker.pid);
      return worker;
    }
    async function once(entry: 'outbox-publisher' | 'event-consumer') {
      const child = spawnStaged(
        new URL(`../../src/bootstrap/${entry}.ts`, import.meta.url).pathname,
        {
          DATABASE_URL: database.config.databaseUrl,
          OUTBOX_QUEUE_NAME: new URL(events.queue).pathname.split('/').at(-1)!,
          OUTBOX_RETRY_BASE_MS: '1',
          OUTBOX_RETRY_MAX_MS: '1',
        },
        ['--once'],
      );
      standalone.push(child);
      evidence.processPids.push(child.pid);
      const result = await child.exit(15000);
      if (result.code !== 0)
        throw new Error(`Recovery ${entry} exit ${result.code}: ${result.logs.join('\n')}`);
      return child.pid;
    }
    return {
      database,
      orm,
      sqs,
      apis,
      commands,
      events,
      expected,
      facts: facts as Readonly<typeof facts>,
      evidence,
      demo,
      sql,
      wallet,
      command,
      http,
      send,
      expectMovement,
      expectRejection,
      expectPendingReference,
      startWorker,
      startPublisher,
      startReferences,
      once,
      stopWorkers,
      close,
      drained: (queue: string) => drainQueue(sqs, queue),
      lockWallet: (w: WalletFixture) => holdWallets(database.owner, w.id),
      blocked: (count: number) => waitForWalletLock(database.owner, count),
      inbox: (messageId: string) =>
        retryUntil(
          () =>
            sql('select message_id from messaging.command_inbox where message_id=?', [messageId]),
          (rows) => rows.length === 1,
          15000,
        ),
      consumer: () =>
        new CommandConsumer(
          createSubmission(new WageringRepository(orm, database.config), database.config),
          sqs,
          {
            queueUrl: commands.queue,
            dlqUrl: commands.dlq,
            financialDeadlineMs: database.config.financialDeadlineMs,
            visibilitySeconds: 30,
            callTimeoutMs: 1000,
            retryBaseMs: 1,
            retryMaxMs: 1,
            waitSeconds: 0,
            drainMs: 100,
          },
        ),
      snapshot: () =>
        sql(
          `select (select count(*)::int from wagering.transactions) transactions,(select count(*)::int from wagering.journal) journal,(select count(*)::int from wagering.submission_receipts) receipts,(select count(*)::int from messaging.command_inbox) inbox,(select count(*)::int from wagering.outbox) outbox,(select jsonb_agg(jsonb_build_array(id,balance,version) order by id) from wagering.wallets) wallets`,
        ),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type RecoveryHarness = Awaited<ReturnType<typeof recoveryHarness>>;
