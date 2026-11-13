import { expect } from 'bun:test';
import {
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { disposableDatabase } from './database';
import { apiProcess } from './api-cluster';
import { commandWorker } from './command-worker';
import { publisherWorker } from './publisher-worker';
import { referenceProcess } from './reference-process';
import { humanToken, providerToken } from './keycloak';
import { retryUntil } from './command-fixture';
import { databaseFault, brokerFault } from './recovery-faults';
import { openDatabase } from '../../src/config/orm';
import { createSqsClient } from '../../src/config/sqs';
import { loadCommandConfig } from '../../src/messaging/commands/config';
import { provisionCommandQueues } from '../../scripts/provision-commands';
import { provisionEventQueues } from '../../scripts/provision-events';
import { CommandConsumer } from '../../src/messaging/commands/command-consumer';
import { createSubmission } from '../../src/modules/wagering/infrastructure/create-submission';
import { WageringRepository } from '../../src/modules/wagering/infrastructure/persistence/wagering-repository';

interface Wallet {
  id: string;
  playerId: string;
}
interface Command {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

export async function recoveryScenario() {
  const database = await disposableDatabase();
  const orm = await openDatabase(database.config);
  const sqs = createSqsClient(database.config);
  const apis: Awaited<ReturnType<typeof apiProcess>>[] = [];
  const workers: ReturnType<typeof commandWorker>[] = [];
  const publishers: ReturnType<typeof publisherWorker>[] = [];
  const queues: string[] = [];
  const expected = new Map<string, string>();
  const evidence: Record<string, unknown> = { at: new Date().toISOString(), scenarios: [] };
  const record = (scenario: string, result: object) => {
    (evidence.scenarios as object[]).push({ scenario, ...result });
    console.log('RECOVERY_STAGE', JSON.stringify({ scenario, ...result }));
  };
  const sql = (query: string, params: unknown[] = []) =>
    database.owner.em.fork().execute(query, params);
  let references: Awaited<ReturnType<typeof referenceProcess>> | undefined;
  try {
    const migrations = await database.owner.getMigrator().getExecutedMigrations();
    await database.owner.getMigrator().down({ to: 0 });
    expect(
      await sql(
        "select schema_name from information_schema.schemata where schema_name in ('wagering','messaging','demo_consumer')",
      ),
    ).toHaveLength(0);
    await database.owner.getMigrator().up();
    expect((await database.owner.getMigrator().getExecutedMigrations()).map((m) => m.name)).toEqual(
      migrations.map((m) => m.name),
    );
    await expect(
      orm.em
        .fork()
        .execute(
          'insert into messaging.command_inbox(consumer_name,message_id,request_hash) values(?,?,?)',
          ['recovery', crypto.randomUUID(), 'a'.repeat(64)],
        ),
    ).rejects.toThrow('null value in column "transaction_id"');
    record('full-migration-roundtrip', {
      migrations: migrations.map((m) => m.name),
      schemasRemoved: true,
      incompleteInboxRejectedAfterRestore: true,
    });
    const commands = await provisionCommandQueues(sqs, {
      ...loadCommandConfig(),
      queueName: `recovery-${crypto.randomUUID()}.fifo`,
    });
    queues.push(commands.queue, commands.dlq);
    const events = await provisionEventQueues(sqs, `recovery-events-${crypto.randomUUID()}.fifo`);
    queues.push(events.queue, events.dlq);
    for (let i = 0; i < 3; i++) apis.push(await apiProcess(database.config, `recovery-api-${i}`));
    const [demo, provider] = await Promise.all([humanToken('demo-operator'), providerToken('a')]);
    const pids = apis.map((api) => api.pid);
    expect(new Set(pids).size).toBe(3);
    evidence.apiPids = pids;
    async function wallet() {
      const response = await fetch(`${apis[0]!.base}/wallets`, {
        method: 'POST',
        headers: headers(demo),
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        }),
      });
      expect(response.status).toBe(201);
      const value = (await response.json()) as Wallet;
      expected.set(value.id, '100.00');
      return value;
    }
    function command(w: Wallet, amount = '80.00'): Command {
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
    async function http(command: Command, index = 0) {
      const { idempotencyKey, ...body } = command;
      const response = await fetch(`${apis[index]!.base}/wagering/transactions`, {
        method: 'POST',
        headers: { ...headers(provider), 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }
    async function send(data: Command, messageId = crypto.randomUUID()) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: commands.queue,
          MessageBody: JSON.stringify({
            messageId,
            type: 'WagerTransactionRequested',
            occurredAt: new Date().toISOString(),
            data,
          }),
          MessageGroupId: data.walletId,
          MessageDeduplicationId: crypto.randomUUID(),
        }),
      );
      return messageId;
    }
    const startWorker = (
      extra: Record<string, string> = {},
      databaseUrl = database.config.databaseUrl,
    ) => {
      const worker = commandWorker(
        { ...database.config, databaseUrl },
        commands.queue,
        commands.dlq,
        extra,
      );
      workers.push(worker);
      return worker;
    };
    async function inbox(messageId: string) {
      await retryUntil(
        () => sql('select message_id from messaging.command_inbox where message_id=?', [messageId]),
        (rows) => rows.length === 1,
        15000,
      );
    }
    async function drained(queue: string) {
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
        (count) => count === 0,
        15000,
      );
    }
    async function lockWallet(w: Wallet) {
      const em = database.owner.em.fork();
      await em.begin();
      await em.execute('select id from wagering.wallets where id=? for update', [w.id]);
      return em;
    }
    async function blocked(count: number) {
      return retryUntil(
        () =>
          sql(
            `select count(distinct application_name)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%from wagering.wallets where id=%'`,
          ),
        (rows) => rows[0].n >= count,
      );
    }
    const firstWorker = startWorker();
    await firstWorker.wait('ready');

    const duplicateWallet = await wallet(),
      duplicate = command(duplicateWallet);
    const lock = await lockWallet(duplicateWallet);
    const httpDuplicates = Array.from({ length: 25 }, (_, i) => http(duplicate, i % 3));
    let duplicateIds: string[];
    try {
      duplicateIds = await Promise.all(Array.from({ length: 25 }, () => send(duplicate)));
      const waiting = await blocked(4); // all three APIs and the independent command worker
      record('mixed-50-barrier', { appProcessesWaiting: waiting[0].n, http: 25, sqs: 25 });
    } finally {
      await lock.commit();
    }
    const receipts = await Promise.all(httpDuplicates);
    expect(receipts.every((r) => r.status === 200)).toBe(true);
    expect(new Set(receipts.map((r) => r.body.transactionId)).size).toBe(1);
    await Promise.all(duplicateIds!.map(inbox));
    await drained(commands.queue);
    expected.set(duplicateWallet.id, '20.00');
    const [duplicateCounts] = await sql(
      `select (select count(*)::int from wagering.transactions where wallet_id=? and kind='BET') transactions,(select count(*)::int from wagering.journal where wallet_id=? and wallet_version=2) debits,(select count(*)::int from messaging.command_inbox where transaction_id=?) inbox`,
      [duplicateWallet.id, duplicateWallet.id, receipts[0]!.body.transactionId],
    );
    expect(duplicateCounts).toEqual({ transactions: 1, debits: 1, inbox: 25 });
    record('mixed-50-result', duplicateCounts);

    const raceWallet = await wallet(),
      raceLock = await lockWallet(raceWallet);
    const httpRace = http(command(raceWallet));
    let raceMessage!: string;
    try {
      raceMessage = await send(command(raceWallet));
      await blocked(2);
    } finally {
      await raceLock.commit();
    }
    await httpRace;
    await inbox(raceMessage);
    expect(
      await sql(
        `select status,count(*)::int n from wagering.transactions where wallet_id=? and kind='BET' group by status order by status`,
        [raceWallet.id],
      ),
    ).toEqual([
      { status: 'PROCESSED', n: 1 },
      { status: 'REJECTED', n: 1 },
    ]);
    expected.set(raceWallet.id, '20.00');
    record('mixed-100-80-race', { processed: 1, rejected: 1, balance: '20.00' });

    const a = await wallet(),
      b = await wallet(),
      independentLock = await lockWallet(a);
    let finished = false;
    const waiting = http(command(a), 1).then((r) => {
      finished = true;
      return r;
    });
    try {
      await blocked(1);
      await inbox(await send(command(b)));
      expect(finished).toBe(false);
      record('independent-wallets', { sqsCompletedWhileHttpWalletLocked: true });
    } finally {
      await independentLock.commit();
    }
    expect((await waiting).status).toBe(200);
    expected.set(a.id, '20.00');
    expected.set(b.id, '20.00');
    await firstWorker.stop();

    const crashWallet = await wallet(),
      crashCommand = command(crashWallet, '20.00');
    const crashId = await send(crashCommand);
    const crashing = startWorker({ COMMAND_TEST_PAUSE: 'committed' });
    expect((await crashing.wait('committed')).messageId).toBe(crashId);
    await crashing.stop('SIGKILL');
    const recovered = startWorker();
    expect((await recovered.wait('committed')).messageId).toBe(crashId);
    expect(recovered.child.pid).not.toBe(crashing.child.pid);
    await drained(commands.queue);
    expected.set(crashWallet.id, '80.00');
    record('postcommit-preack-restart', {
      killedPid: crashing.child.pid,
      replacementPid: recovered.child.pid,
      messageId: crashId,
    });

    const referenceWallet = await wallet(),
      bet = command(referenceWallet, '20.00');
    const refund: Command = {
      ...bet,
      kind: 'REFUND',
      idempotencyKey: crypto.randomUUID(),
      externalTransactionId: crypto.randomUUID(),
      referenceExternalTransactionId: bet.externalTransactionId,
    };
    await inbox(await send(refund));
    expect(
      (
        await sql('select status from wagering.transactions where external_transaction_id=?', [
          refund.externalTransactionId,
        ])
      )[0].status,
    ).toBe('PENDING_REFERENCE');
    await recovered.stop();
    const referenceRestart = startWorker();
    await referenceRestart.wait('ready');
    await inbox(await send(bet));
    references = await referenceProcess(database.config);
    await retryUntil(
      () =>
        sql('select status from wagering.transactions where external_transaction_id=?', [
          refund.externalTransactionId,
        ]),
      (rows) => rows[0].status === 'PROCESSED',
      15000,
    );
    await references.kill();
    references = undefined;
    record('out-of-order-reference-after-restart', {
      originalConsumerPid: recovered.child.pid,
      restartedConsumerPid: referenceRestart.child.pid,
      balance: '100.00',
    });
    await drained(commands.queue);
    await referenceRestart.stop();

    const unavailableWallet = await wallet();
    const pg = await databaseFault(database.config.databaseUrl);
    try {
      pg.setAvailable(false);
      const message = await send(command(unavailableWallet, '20.00'));
      const unavailableWorker = startWorker({}, pg.url);
      await unavailableWorker.wait('ready');
      await retryUntil(
        async () => pg.rejected,
        (n) => n > 0,
      );
      expect(
        await sql('select * from messaging.command_inbox where message_id=?', [message]),
      ).toHaveLength(0);
      expect(
        (
          await sql('select balance::text from wagering.wallets where id=?', [unavailableWallet.id])
        )[0].balance,
      ).toBe('100.00');
      pg.setAvailable(true);
      try {
        expect((await unavailableWorker.wait('committed', 20000)).messageId).toBe(message);
      } catch (error) {
        await unavailableWorker.stop('SIGKILL');
        console.error(await unavailableWorker.logs);
        throw error;
      }
      await drained(commands.queue);
      await unavailableWorker.stop();
      expected.set(unavailableWallet.id, '80.00');
      record('postgres-unavailable', {
        refusedConnections: pg.rejected,
        recoveredWithoutReinjection: true,
      });
    } finally {
      await pg.close();
    }

    // Real SQL faults at each atomic write, using the production command consumer.
    const consumer = new CommandConsumer(
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
    );
    const boundaries = [
      ['wagering', 'transactions', 'insert'],
      ['wagering', 'wallets', 'update'],
      ['wagering', 'journal', 'insert'],
      ['wagering', 'submission_receipts', 'insert'],
      ['messaging', 'command_inbox', 'insert'],
      ['wagering', 'outbox', 'insert'],
    ] as const;
    const snapshot = () =>
      sql(
        `select (select count(*)::int from wagering.transactions) transactions,(select count(*)::int from wagering.journal) journal,(select count(*)::int from wagering.submission_receipts) receipts,(select count(*)::int from messaging.command_inbox) inbox,(select count(*)::int from wagering.outbox) outbox,(select jsonb_agg(jsonb_build_array(id,balance,version) order by id) from wagering.wallets) wallets`,
      );
    for (const [schema, table, operation] of boundaries) {
      const w = await wallet(),
        data = command(w, '20.00');
      const before = await snapshot();
      await sql(
        `create function ${schema}.recovery_fault() returns trigger language plpgsql as $$ begin raise exception 'recovery fault at ${table}'; end $$; create trigger recovery_fault before ${operation} on ${schema}.${table} for each row execute function ${schema}.recovery_fault()`,
      );
      try {
        await send(data);
        expect(await consumer.runOnce()).toBe(1);
        expect(await snapshot()).toEqual(before);
      } finally {
        await sql(
          `drop trigger recovery_fault on ${schema}.${table}; drop function ${schema}.recovery_fault()`,
        );
      }
      await retryUntil(
        () => consumer.runOnce(),
        (count) => count === 1,
      );
      expected.set(w.id, '80.00');
      record('atomic-write-rollback', { boundary: `${schema}.${table}`, zeroPartialEffects: true });
    }
    await drained(commands.queue);

    // Publisher faults are isolated to its HTTP proxy; other tasks keep their broker.
    const broker = brokerFault(database.config.sqsEndpoint, events.queue);
    try {
      const unavailable = publisherWorker(
        { ...database.config, sqsEndpoint: broker.endpoint },
        broker.queue,
      );
      publishers.push(unavailable);
      const failedPublish = await unavailable.exit();
      expect(failedPublish.code).toBe(0);
      expect(failedPublish.logs.join('\n')).toContain('outbox_retry');
      expect(broker.rejected).toBeGreaterThan(0);
      const retrying = await sql(
        'select event_id from wagering.outbox where attempts>0 and published_at is null and blocked_at is null and lease_token is null',
      );
      expect(retrying).toHaveLength(1);
      broker.restore();
      await retryUntil(
        () =>
          sql(
            'select next_attempt_at<=clock_timestamp() ready from wagering.outbox where event_id=?',
            [retrying[0].event_id],
          ),
        (rows) => rows[0].ready,
      );
      const restored = publisherWorker(
        { ...database.config, sqsEndpoint: broker.endpoint },
        broker.queue,
      );
      publishers.push(restored);
      expect((await restored.exit()).code).toBe(0);
      expect(
        (
          await sql('select published_at from wagering.outbox where event_id=?', [
            retrying[0].event_id,
          ])
        )[0].published_at,
      ).not.toBeNull();
      record('sqs-unavailable', {
        refusedRequests: broker.rejected,
        retainedRetryableEvents: retrying.length,
      });
    } finally {
      await broker.close();
    }

    // Two live processes reserve different heads before either may send.
    const concurrent = [
      publisherWorker(database.config, events.queue, 'reserved'),
      publisherWorker(database.config, events.queue, 'reserved'),
    ];
    publishers.push(...concurrent);
    const reservations = await Promise.all(concurrent.map((p) => p.wait('reserved')));
    expect(new Set(reservations.map((r) => r.eventId)).size).toBe(2);
    expect(new Set(concurrent.map((p) => p.pid)).size).toBe(2);
    concurrent.forEach((p) => p.release());
    for (const p of concurrent) expect((await p.exit()).code).toBe(0);
    record('two-publishers-barrier', {
      pids: concurrent.map((p) => p.pid),
      reservedEventIds: reservations.map((r) => r.eventId),
    });

    const publisherCrash = publisherWorker(database.config, events.queue, 'sent');
    publishers.push(publisherCrash);
    const sent = await publisherCrash.wait('sent');
    expect(
      (await sql('select published_at from wagering.outbox where event_id=?', [sent.eventId]))[0]
        .published_at,
    ).toBeNull();
    await publisherCrash.kill();
    await retryUntil(
      () =>
        sql('select lease_until<=clock_timestamp() expired from wagering.outbox where event_id=?', [
          sent.eventId,
        ]),
      (rows) => rows[0].expired,
    );
    record('postsend-preconfirm-crash', { killedPid: publisherCrash.pid, eventId: sent.eventId });

    // Restart real standalone publishers/consumer and drain every committed event.
    async function once(entry: string) {
      const child = Bun.spawn([process.execPath, `src/bootstrap/${entry}.ts`, '--once'], {
        env: {
          ...process.env,
          DATABASE_URL: database.config.databaseUrl,
          OUTBOX_QUEUE_NAME: new URL(events.queue).pathname.split('/').at(-1)!,
          OUTBOX_RETRY_BASE_MS: '1',
          OUTBOX_RETRY_MAX_MS: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
      try {
        const [code, out, err] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (code !== 0) throw new Error(`Recovery ${entry} exit ${code}: ${err} ${out}`);
        return child.pid;
      } finally {
        clearTimeout(timeout);
      }
    }
    await retryUntil(
      async () => {
        await Promise.all([once('outbox-publisher'), once('outbox-publisher')]);
        await once('event-consumer');
        return (
          await sql('select count(*)::int n from wagering.outbox where published_at is null')
        )[0].n;
      },
      (n) => n === 0,
      30000,
    );
    await retryUntil(
      async () => {
        await once('event-consumer');
        return (
          await sql(
            'select (select count(*) from wagering.outbox)-(select count(*) from demo_consumer.event_inbox) as n',
          )
        )[0].n;
      },
      (n) => Number(n) === 0,
      30000,
    );
    await drained(events.queue);
    // Force a transport redelivery with a fresh FIFO dedup ID; inbox must still win.
    const [replay] = await sql('select payload,sequence from wagering.outbox where event_id=?', [
      sent.eventId,
    ]);
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: events.queue,
        MessageBody: JSON.stringify({ ...replay.payload, sequence: replay.sequence }),
        MessageGroupId: replay.payload.aggregateId,
        MessageDeduplicationId: crypto.randomUUID(),
      }),
    );
    await once('event-consumer');
    await drained(events.queue);
    record('event-recovery', { redeliveredEventId: sent.eventId, stableIdPersistentDedup: true });

    await apis[0]!.stop();
    apis[0] = await apiProcess(database.config, 'recovery-api-restarted');
    expect((await http(duplicate)).body.idempotentReplay).toBe(true);
    // Every row in this disposable DB must be known and reconciled, not just sampled.
    await expect(
      orm.em.fork().transactional(async (em) => {
        await em.execute('update wagering.wallets set balance=balance+1 where id=?', [
          duplicateWallet.id,
        ]);
      }),
    ).rejects.toThrow();
    await expect(
      orm.em.fork().execute('update wagering.journal set amount=amount'),
    ).rejects.toThrow();
    const walletRows = await sql(
      'select id,balance::text,version from wagering.wallets order by id',
    );
    expect(walletRows).toHaveLength(expected.size);
    const reconciled = [];
    for (const w of walletRows) {
      const response = await fetch(`${apis[0]!.base}/wallets/${w.id}/reconciliation`, {
        method: 'POST',
        headers: headers(demo),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as Record<string, unknown>;
      expect(result).toMatchObject({
        consistent: true,
        storedBalance: { amount: expected.get(w.id), currency: 'BRL' },
        calculatedBalance: { amount: expected.get(w.id), currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
      });
      reconciled.push({ walletId: w.id, balance: w.balance, version: w.version, ...result });
    }
    const [invariants] = await sql(`select
      (select count(*)::int from wagering.journal j join wagering.accounts d on d.id=j.debit_account_id join wagering.accounts c on c.id=j.credit_account_id where j.amount<=0 or d.id=c.id or d.currency<>j.currency or c.currency<>j.currency) invalid_pairs,
      (select count(*)::int from wagering.transactions t where (t.status='PROCESSED' and t.kind<>'LOSS' and t.amount>0 and (select count(*) from wagering.journal j where j.transaction_id=t.id)<>1) or (t.status<>'PROCESSED' and exists(select from wagering.journal j where j.transaction_id=t.id))) partial_financial_effects,
      (select count(*)::int from wagering.transactions t where t.kind<>'OPENING' and (select count(*) from wagering.submission_receipts r where r.transaction_id=t.id)<>1) missing_receipts,
      (select count(*)::int from wagering.transactions t where t.status in ('PENDING','PENDING_REFERENCE')) pending_transactions,
      (select count(*)::int from wagering.outbox where published_at is null or blocked_at is not null or lease_token is not null) pending_events,
      (select count(*)::int from wagering.outbox o left join demo_consumer.event_inbox i on i.event_id=o.event_id where i.event_id is null) missing_deliveries,
      (select count(*)::int from wagering.wallets w join demo_consumer.event_projection p on p.aggregate_id=w.id where p.wallet_version<>w.version or (p.balance->>'amount')::numeric<>w.balance) stale_projections,
      (select count(*)::int from wagering.transactions t where t.kind<>'OPENING' and ((select count(*) from wagering.outbox o where o.transaction_id=t.id and o.event_type=case t.status when 'PROCESSED' then 'WagerTransactionProcessed' else 'WagerTransactionRejected' end)<>1 or (select count(*) from wagering.outbox o where o.transaction_id=t.id and o.event_type='WalletBalanceChanged')<>case when t.status='PROCESSED' then 1 else 0 end)) invalid_event_sets`);
    expect(Object.values(invariants).every((n) => n === 0)).toBe(true);
    const [eventsAudit] = await sql(
      'select count(*)::int total,count(distinct event_id)::int unique_events from wagering.outbox',
    );
    expect(eventsAudit).toEqual({ total: 43, unique_events: 43 });
    expect((await sql('select count(*)::int n from demo_consumer.event_inbox'))[0].n).toBe(
      eventsAudit.total,
    );
    expect((await sql('select count(*)::int n from demo_consumer.event_projection'))[0].n).toBe(
      expected.size,
    );
    const totals = await sql(
      `select currency,count(*)::int journal_entries,sum(amount)::text paired_amount from wagering.journal group by currency`,
    );
    // Worked scenario: 13 openings of100 + four BET80 + ten movements of20.
    // Each row encodes equal debit/credit; invalid_pairs checks accounts/currencies above.
    expect(totals).toEqual([{ currency: 'BRL', journal_entries: 27, paired_amount: '1820.00' }]);
    for (const queue of [commands.dlq, events.dlq]) await drained(queue);
    evidence.final = {
      walletCount: expected.size,
      reconciled,
      invariants,
      events: eventsAudit,
      journalTotals: totals,
      commandQueueDrained: true,
      eventQueueDrained: true,
      dlqsEmpty: true,
    };
    record('all-wallets-reconciled', {
      wallets: expected.size,
      events: eventsAudit.total,
      ...invariants,
    });
    if (process.env.RECOVERY_EVIDENCE_PATH)
      await Bun.write(process.env.RECOVERY_EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n');
  } finally {
    await references?.kill();
    await Promise.allSettled(workers.map((worker) => worker.stop('SIGKILL')));
    await Promise.allSettled(publishers.map((publisher) => publisher.kill()));
    await Promise.allSettled(apis.map((api) => api.stop()));
    await Promise.allSettled(
      queues.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))),
    );
    sqs.destroy();
    await orm.close(true);
    await database.close();
  }
}
