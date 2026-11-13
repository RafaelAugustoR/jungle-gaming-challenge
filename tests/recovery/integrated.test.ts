import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { recoveryHarness, type RecoveryHarness } from '../support/recovery-harness';
import { assertRecovery } from '../support/recovery-audit';
import type { CommandData } from '../support/command-fixture';
import { databaseFault, brokerFault } from '../support/recovery-faults';
import { retryUntil } from '../support/poll';
import { apiProcess } from '../support/api-cluster';

const recovery = process.env.RECOVERY === '1' ? test : test.skip;
describe('integrated recovery timeline', () => {
  let h: RecoveryHarness;
  let duplicateCommand!: CommandData;
  let sentEventId: string;
  let plannedStages = 0;
  beforeAll(async () => {
    if (process.env.RECOVERY === '1') h = await recoveryHarness();
  }, 30000);
  afterEach(async () => {
    await h?.stopWorkers();
  });
  afterAll(async () => {
    if (!h) return;
    try {
      if (
        h.evidence.final &&
        h.evidence.stages.length === plannedStages &&
        process.env.RECOVERY_EVIDENCE_PATH
      )
        await Bun.write(
          process.env.RECOVERY_EVIDENCE_PATH,
          JSON.stringify(h.evidence, null, 2) + '\n',
        );
    } finally {
      await h.close();
    }
  });
  function stage(name: string, run: (h: RecoveryHarness) => Promise<void>) {
    plannedStages++;
    recovery(
      name,
      async () => {
        await run(h);
        await h.drained(h.commands.queue);
        h.evidence.stages.push(name);
      },
      45000,
    );
  }
  stage(
    'all migrations reverse to zero and restore enforced constraints',
    async ({ database, orm, sql }) => {
      const migrations = await database.owner.getMigrator().getExecutedMigrations();
      await database.owner.getMigrator().down({ to: 0 });
      expect(
        await sql(
          "select schema_name from information_schema.schemata where schema_name in ('wagering','messaging','demo_consumer')",
        ),
      ).toHaveLength(0);
      await database.owner.getMigrator().up();
      expect(
        (await database.owner.getMigrator().getExecutedMigrations()).map((m) => m.name),
      ).toEqual(migrations.map((m) => m.name));
      await expect(
        orm.em
          .fork()
          .execute(
            'insert into messaging.command_inbox(consumer_name,message_id,request_hash) values(?,?,?)',
            ['recovery', crypto.randomUUID(), 'a'.repeat(64)],
          ),
      ).rejects.toThrow('null value in column "transaction_id"');
    },
  );

  stage(
    '25 parallel HTTP submissions overlap one FIFO consumer draining 25 SQS duplicates',
    async ({
      commands,
      sql,
      wallet,
      command,
      http,
      send,
      expectMovement,
      startWorker,
      drained,
      lockWallet,
      blocked,
      inbox,
    }) => {
      const firstWorker = startWorker();
      await firstWorker.wait('ready');

      const duplicateWallet = await wallet();
      duplicateCommand = command(duplicateWallet);
      const lock = await lockWallet(duplicateWallet);
      const httpDuplicates = Array.from({ length: 25 }, (_, i) => http(duplicateCommand, i % 3));
      let duplicateIds: string[];
      try {
        duplicateIds = await Promise.all(Array.from({ length: 25 }, () => send(duplicateCommand)));
        const waiting = await blocked(4);
        expect(waiting).toBeGreaterThanOrEqual(4); // all three APIs and the independent command worker
      } finally {
        await lock.commit();
      }
      const receipts = await Promise.all(httpDuplicates);
      expect(receipts.every((r) => r.status === 200)).toBe(true);
      expect(new Set(receipts.map((r) => r.body.transactionId)).size).toBe(1);
      await Promise.all(duplicateIds!.map(inbox));
      await drained(commands.queue);
      expectMovement(duplicateWallet, '20.00', '80.00');
      const [duplicateCounts] = await sql(
        `select (select count(*)::int from wagering.transactions where wallet_id=? and kind='BET') transactions,(select count(*)::int from wagering.journal where wallet_id=? and wallet_version=2) debits,(select count(*)::int from messaging.command_inbox where transaction_id=?) inbox`,
        [duplicateWallet.id, duplicateWallet.id, receipts[0]!.body.transactionId],
      );
      expect(duplicateCounts).toEqual({ transactions: 1, debits: 1, inbox: 25 });
    },
  );

  stage(
    'HTTP and SQS BET 80.00 compete for 100.00 with one approval and one rejection',
    async ({
      facts,
      sql,
      wallet,
      command,
      http,
      send,
      expectMovement,
      startWorker,
      lockWallet,
      blocked,
      inbox,
    }) => {
      await startWorker().wait('ready');
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
      expectMovement(raceWallet, '20.00', '80.00');
      facts.events++; // one rejected BET
    },
  );

  stage(
    'another wallet commits while the first remains locked',
    async ({
      wallet,
      command,
      http,
      send,
      expectMovement,
      startWorker,
      lockWallet,
      blocked,
      inbox,
    }) => {
      await startWorker().wait('ready');
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
      } finally {
        await independentLock.commit();
      }
      expect((await waiting).status).toBe(200);
      expectMovement(a, '20.00', '80.00');
      expectMovement(b, '20.00', '80.00');
    },
  );

  stage(
    'SIGKILL postcommit preack recovers the same delivery in a new process',
    async ({ commands, wallet, command, send, expectMovement, startWorker, drained }) => {
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
      expectMovement(crashWallet, '80.00', '20.00');
    },
  );

  stage(
    'SQS REFUND precedes its BET and survives consumer restart',
    async ({
      commands,
      facts,
      sql,
      wallet,
      command,
      send,
      expectMovement,
      startWorker,
      startReferences,
      drained,
      inbox,
    }) => {
      const recovered = startWorker();
      await recovered.wait('ready');
      const referenceWallet = await wallet(),
        bet = command(referenceWallet, '20.00');
      const refund: CommandData = {
        ...bet,
        kind: 'REFUND',
        idempotencyKey: crypto.randomUUID(),
        externalTransactionId: crypto.randomUUID(),
        referenceExternalTransactionId: bet.externalTransactionId,
      };
      await inbox(await send(refund));
      facts.events++; // persisted pending-reference event
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
      const references = await startReferences();
      await retryUntil(
        () =>
          sql('select status from wagering.transactions where external_transaction_id=?', [
            refund.externalTransactionId,
          ]),
        (rows) => rows[0].status === 'PROCESSED',
        15000,
      );
      await references.kill();

      await drained(commands.queue);
      await referenceRestart.stop();

      expectMovement(referenceWallet, '80.00', '20.00');
      expectMovement(referenceWallet, '100.00', '20.00');
    },
  );

  stage(
    'isolated PostgreSQL outage retries without partial effects or reinjection',
    async ({
      database,
      commands,
      sql,
      wallet,
      command,
      send,
      expectMovement,
      startWorker,
      drained,
    }) => {
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
            await sql('select balance::text from wagering.wallets where id=?', [
              unavailableWallet.id,
            ])
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
        expectMovement(unavailableWallet, '80.00', '20.00');
      } finally {
        await pg.close();
      }
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
  for (const [schema, table, operation] of boundaries) {
    stage(
      `atomic rollback at ${schema}.${table}`,
      async ({ sql, wallet, command, send, expectMovement }) => {
        const consumer = h.consumer();
        const snapshot = h.snapshot;
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
        expectMovement(w, '80.00', '20.00');
      },
    );
  }
  stage(
    'isolated SQS outage retains the event and publishes after restore',
    async ({ database, events, sql, startPublisher }) => {
      // Publisher faults are isolated to its HTTP proxy; other tasks keep their broker.
      const broker = brokerFault(database.config.sqsEndpoint, events.queue);
      try {
        const unavailable = startPublisher(
          { ...database.config, sqsEndpoint: broker.endpoint },
          broker.queue,
        );

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
        const restored = startPublisher(
          { ...database.config, sqsEndpoint: broker.endpoint },
          broker.queue,
        );

        expect((await restored.exit()).code).toBe(0);
        expect(
          (
            await sql('select published_at from wagering.outbox where event_id=?', [
              retrying[0].event_id,
            ])
          )[0].published_at,
        ).not.toBeNull();
      } finally {
        await broker.close();
      }
    },
  );

  stage(
    'two publisher processes reserve disjoint heads before sending',
    async ({ database, events, startPublisher }) => {
      // Two live processes reserve different heads before either may send.
      const concurrent = [
        startPublisher(database.config, events.queue, { pause: 'reserved', leaseMs: 5000 }),
        startPublisher(database.config, events.queue, { pause: 'reserved', leaseMs: 5000 }),
      ];

      const reservations = await Promise.all(concurrent.map((p) => p.wait('reserved')));
      expect(new Set(reservations.map((r) => r.eventId)).size).toBe(2);
      expect(new Set(concurrent.map((p) => p.pid)).size).toBe(2);
      concurrent.forEach((p) => p.release());
      for (const p of concurrent) expect((await p.exit()).code).toBe(0);
    },
  );

  stage(
    'SIGKILL postsend preconfirm leaves a recoverable event lease',
    async ({ database, events, sql, startPublisher }) => {
      const publisherCrash = startPublisher(database.config, events.queue, {
        pause: 'sent',
        leaseMs: 1000,
      });

      const sent = await publisherCrash.wait('sent');
      expect(
        (await sql('select published_at from wagering.outbox where event_id=?', [sent.eventId]))[0]
          .published_at,
      ).toBeNull();
      await publisherCrash.kill();
      await retryUntil(
        () =>
          sql(
            'select lease_until<=clock_timestamp() expired from wagering.outbox where event_id=?',
            [sent.eventId],
          ),
        (rows) => rows[0].expired,
      );

      sentEventId = sent.eventId!;
    },
  );

  stage(
    'production entrypoints drain the outbox and persistently deduplicate redelivery',
    async ({ sqs, events, sql, once, drained }) => {
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
        sentEventId,
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
    },
  );

  stage(
    'API restart preserves receipts and every wallet event and journal reconciles',
    async ({ database, apis, http }) => {
      await apis[0]!.stop();
      apis[0] = await apiProcess(database.config, 'recovery-api-restarted');
      expect((await http(duplicateCommand)).body.idempotentReplay).toBe(true);
      expect(h.evidence.stages).toHaveLength(plannedStages - 1);
      h.evidence.final = await assertRecovery(h);
    },
  );
});
