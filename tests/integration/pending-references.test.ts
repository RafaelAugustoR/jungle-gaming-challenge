import { lockWalletRows } from '../support/sql-barrier';
import { openDatabase } from '../../src/config/orm';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../../src/bootstrap/application';
import { disposableDatabase } from '../support/database';
import { humanToken, providerToken } from '../support/keycloak';
import { ReprocessReferences } from '../../src/modules/wagering/application/reprocess-references';
import { WageringRepository } from '../../src/modules/wagering/infrastructure/persistence/wagering-repository';
import { ReferenceRetryPolicy } from '../../src/modules/wagering/domain/reference-retry';
const integration = process.env.INTEGRATION === '1' ? test : test.skip;
let db: Awaited<ReturnType<typeof disposableDatabase>>,
  app: INestApplication,
  base: string,
  human: string,
  provider: string;
let runtime: Awaited<ReturnType<typeof openDatabase>>, runner: ReprocessReferences;
beforeAll(async () => {
  if (process.env.INTEGRATION !== '1') return;
  db = await disposableDatabase();
  app = await createApplication(db.config);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  runtime = await openDatabase(db.config);
  runner = new ReprocessReferences(
    new WageringRepository(runtime, db.config),
    new ReferenceRetryPolicy({ ttlMs: 900000, baseMs: 1000, maxMs: 30000 }),
  );
  [human, provider] = await Promise.all([humanToken('demo-operator'), providerToken('a')]);
});
afterAll(async () => {
  await app?.close();
  await runtime?.close(true);
  await db?.close();
});
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});
async function wallet(amount = '100.00') {
  const r = await fetch(`${base}/wallets`, {
    method: 'POST',
    headers: headers(human),
    body: JSON.stringify({
      playerId: crypto.randomUUID(),
      initialBalance: { amount, currency: 'BRL' },
    }),
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; playerId: string };
}
function command(
  w: { id: string; playerId: string },
  kind: string,
  amount = '20.00',
  reference?: string,
) {
  return {
    providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(),
    walletId: w.id,
    playerId: w.playerId,
    roundId: 'round',
    gameId: 'game',
    kind,
    money: { amount, currency: 'BRL' },
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  };
}
async function submit(body: object, key = crypto.randomUUID()) {
  const r = await fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: { ...headers(provider), 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}
async function state(id: string) {
  return (await fetch(`${base}/wallets/${id}`, { headers: headers(human) })).json() as Promise<any>;
}
async function audit(id: string) {
  const [r] = await db.owner.em.execute(
    `select w.balance::text balance,w.version,(select coalesce(sum(case when credit_account_id=w.account_id then amount else -amount end),0)::text from wagering.journal where wallet_id=w.id) reconstructed,(select count(*)::int from wagering.journal where wallet_id=w.id) entries from wagering.wallets w where id=?`,
    [id],
  );
  expect(r.balance).toBe(r.reconstructed);
  return r;
}
async function due(id: string, deadline?: string) {
  await db.owner.em.execute(
    `update wagering.reference_retries set next_attempt_at=clock_timestamp()-interval '1 second' ${deadline ? ',deadline=?' : ''} where transaction_id=?`,
    [...(deadline ? [deadline] : []), id],
  );
}
async function current(id: string) {
  return (
    await fetch(`${base}/wagering/transactions/${id}`, { headers: headers(provider) })
  ).json() as Promise<any>;
}
async function schedule(id: string) {
  const [row] = await db.owner.em.execute(
    'select * from wagering.reference_retries where transaction_id=?',
    [id],
  );
  return row;
}
integration(
  'pending retry is event-silent; resolution preserves accepted 202 and current GET balance',
  async () => {
    const w = await wallet(),
      origin = command(w, 'BET'),
      refund = command(w, 'REFUND', '20.00', origin.externalTransactionId),
      key = crypto.randomUUID();
    const accepted = await submit(refund, key);
    expect(accepted.status).toBe(202);
    const initial = await schedule(accepted.body.transactionId);
    await due(accepted.body.transactionId);
    expect(await runner.runBatch(50)).toBe(0);
    expect((await schedule(accepted.body.transactionId)).attempts).toBe(1);
    await submit(origin);
    await due(accepted.body.transactionId);
    expect(await runner.runBatch(50)).toBe(1);
    expect(await current(accepted.body.transactionId)).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00' },
    });
    expect(await submit(refund, key)).toEqual({
      status: 202,
      body: { ...accepted.body, idempotentReplay: true },
    });
    const completed = await schedule(accepted.body.transactionId);
    expect(completed.deadline).toEqual(initial.deadline);
    expect(completed.completed_at).not.toBeNull();
    const events = await db.owner.em.execute(
      'select event_type,count(*)::int n from wagering.outbox where transaction_id=? group by event_type',
      [accepted.body.transactionId],
    );
    expect(events).toContainEqual({ event_type: 'WagerTransactionPendingReference', n: 1 });
    expect(events).toContainEqual({ event_type: 'WagerTransactionProcessed', n: 1 });
    expect(await audit(w.id)).toMatchObject({ entries: 3, version: 3 });
  },
);
integration(
  'WIN/LOSS/REFUND/ROLLBACK accepted before their reference resolve once under concurrent workers',
  async () => {
    for (const kind of ['WIN', 'LOSS', 'REFUND', 'ROLLBACK']) {
      const w = await wallet(),
        origin = command(w, 'BET'),
        pending = await submit(command(w, kind, '20.00', origin.externalTransactionId));
      await submit(origin);
      await due(pending.body.transactionId);
      await Promise.all(Array.from({ length: 6 }, () => runner.runBatch(50)));
      expect(await current(pending.body.transactionId)).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: kind === 'LOSS' ? '80.00' : '100.00' },
      });
      const [count] = await db.owner.em.execute(
        "select count(*)::int n from wagering.outbox where transaction_id=? and event_type='WagerTransactionProcessed'",
        [pending.body.transactionId],
      );
      expect(count.n).toBe(1);
      await audit(w.id);
    }
  },
);
integration(
  'expiry distinguishes absent, still pending and late references; timely references survive delayed polling',
  async () => {
    const past = new Date(Date.now() - 10000).toISOString();
    for (const mode of ['missing', 'pending', 'late', 'timely', 'terminal']) {
      const w = await wallet(),
        origin = command(
          w,
          mode === 'pending' ? 'WIN' : 'BET',
          mode === 'terminal' ? '999.00' : '20.00',
          mode === 'pending' ? crypto.randomUUID() : undefined,
        );
      const kind = mode === 'pending' ? 'ROLLBACK' : 'REFUND';
      const accepted = await submit(
        command(w, kind, mode === 'terminal' ? '999.00' : '20.00', origin.externalTransactionId),
      );
      if (mode === 'late') await due(accepted.body.transactionId, past);
      if (mode !== 'missing') await submit(origin);
      if (mode === 'timely') {
        const [ref] = await db.owner.em.execute(
          'select processed_at from wagering.transactions where provider_id=? and external_transaction_id=?',
          ['provider-a', origin.externalTransactionId],
        );
        await due(
          accepted.body.transactionId,
          new Date(new Date(ref.processed_at).getTime() + 1).toISOString(),
        );
      } else await due(accepted.body.transactionId, past);
      await runner.runBatch(50);
      expect(await current(accepted.body.transactionId)).toMatchObject(
        mode === 'timely'
          ? { status: 'PROCESSED' }
          : {
              status: 'REJECTED',
              failureCode:
                mode === 'missing'
                  ? 'REFERENCE_NOT_FOUND'
                  : mode === 'terminal'
                    ? 'REFERENCE_NOT_PROCESSED'
                    : 'REFERENCE_NOT_READY',
            },
      );
      await audit(w.id);
    }
  },
);
integration(
  'outbox failure rolls back pending transition, schedule, journal and wallet; retry recovers',
  async () => {
    const w = await wallet(),
      origin = command(w, 'BET'),
      pending = await submit(command(w, 'REFUND', '20.00', origin.externalTransactionId));
    await submit(origin);
    await due(pending.body.transactionId);
    await db.owner.em.execute(
      `create function wagering.fail_reference_event() returns trigger language plpgsql as $$ begin if NEW.transaction_id='${pending.body.transactionId}' and NEW.event_type='WagerTransactionProcessed' then raise exception 'injected outbox failure'; end if; return NEW; end $$`,
    );
    await db.owner.em.execute(
      'create trigger fail_reference_event before insert on wagering.outbox for each row execute function wagering.fail_reference_event()',
    );
    try {
      await expect(
        runner.execute({ walletId: w.id, transactionId: pending.body.transactionId }),
      ).rejects.toThrow();
    } finally {
      await db.owner.em.execute('drop trigger fail_reference_event on wagering.outbox');
      await db.owner.em.execute('drop function wagering.fail_reference_event()');
    }
    expect(await current(pending.body.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
    });
    expect((await schedule(pending.body.transactionId)).attempts).toBe(0);
    expect(await audit(w.id)).toMatchObject({ entries: 2, balance: '80.00' });
    expect(await runner.runBatch(50)).toBe(1);
    expect(await current(pending.body.transactionId)).toMatchObject({ status: 'PROCESSED' });
  },
);

integration(
  'separate worker processes recover persisted retries after restart and arbitrate with submissions',
  async () => {
    const { referenceProcess } = await import('../support/reference-process');
    const w = await wallet(),
      origin = command(w, 'BET'),
      pending = await submit(command(w, 'REFUND', '20.00', origin.externalTransactionId));
    // Kill a real process while work is persisted but not due. Its successor requires no in-memory state.
    await db.owner.em.execute(
      "update wagering.reference_retries set next_attempt_at=clock_timestamp()+interval '1 hour' where transaction_id=?",
      [pending.body.transactionId],
    );
    const original = await referenceProcess(db.config);
    await original.kill();
    await submit(origin);
    await due(pending.body.transactionId);
    const workers = await Promise.all(Array.from({ length: 3 }, () => referenceProcess(db.config)));
    expect(new Set(workers.map((w) => w.pid)).size).toBe(3);
    try {
      const timeout = Date.now() + 8000;
      while ((await current(pending.body.transactionId)).status === 'PENDING_REFERENCE') {
        if (Date.now() > timeout) throw new Error('Pending reference did not recover');
        await Bun.sleep(25);
      }
      expect(await current(pending.body.transactionId)).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: '100.00' },
      });
      const [events] = await db.owner.em.execute(
        "select count(*)::int n from wagering.outbox where transaction_id=? and event_type='WagerTransactionProcessed'",
        [pending.body.transactionId],
      );
      expect(events.n).toBe(1);
      expect(await audit(w.id)).toMatchObject({ entries: 3, version: 3 });
    } finally {
      await Promise.all(workers.map((w) => w.stop()));
    }
  },
);

integration(
  'expired pending operation remains retryable on infrastructure lock failure',
  async () => {
    const w = await wallet(),
      pending = await submit(command(w, 'REFUND', '20.00', crypto.randomUUID()));
    await due(pending.body.transactionId, new Date(Date.now() - 1000).toISOString());
    const impatient = new ReprocessReferences(
      new WageringRepository(runtime, {
        ...db.config,
        financialLockTimeoutMs: 50,
        financialDeadlineMs: 500,
      }),
      new ReferenceRetryPolicy({ ttlMs: 900000, baseMs: 1000, maxMs: 30000 }),
    );
    await db.owner.em.fork().transactional(async (em) => {
      await lockWalletRows(em, w.id);
      await expect(
        impatient.execute({ walletId: w.id, transactionId: pending.body.transactionId }),
      ).rejects.toMatchObject({ code: 'INFRASTRUCTURE_UNAVAILABLE' });
      expect(await impatient.runBatch(50)).toBe(0);
    });
    expect(await current(pending.body.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
    });
    const deferred = await schedule(pending.body.transactionId);
    expect(deferred.attempts).toBe(1);
    expect(new Date(deferred.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    await due(pending.body.transactionId);
    await runner.execute({ walletId: w.id, transactionId: pending.body.transactionId });
    expect(await current(pending.body.transactionId)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
    });
  },
);

integration(
  'self-reference rejects before acceptance and known pending incompatibility does not wait for TTL',
  async () => {
    const w = await wallet(),
      self = command(w, 'ROLLBACK'),
      key = crypto.randomUUID();
    self.referenceExternalTransactionId = self.externalTransactionId;
    expect((await submit(self, key)).status).toBe(400);
    const valid = { ...self, referenceExternalTransactionId: crypto.randomUUID() };
    expect((await submit(valid, key)).status).toBe(202);
    const origin = command(w, 'WIN', '20.00', crypto.randomUUID());
    expect((await submit(origin)).status).toBe(202);
    const invalid = await submit(command(w, 'ROLLBACK', '21.00', origin.externalTransactionId));
    expect(invalid.status).toBe(422);
    expect(invalid.body.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    expect(await schedule(invalid.body.transactionId)).toBeUndefined();
  },
);

integration(
  'a failed first candidate is deferred while a healthy second candidate completes',
  async () => {
    const broken = await wallet(),
      healthy = await wallet(),
      a = command(broken, 'BET'),
      b = command(healthy, 'BET');
    const first = await submit(command(broken, 'REFUND', '20.00', a.externalTransactionId));
    const second = await submit(command(healthy, 'REFUND', '20.00', b.externalTransactionId));
    await submit(a);
    await submit(b);
    await due(first.body.transactionId);
    await due(second.body.transactionId);
    // Force ordering and a deterministic storage failure on the first candidate only.
    await db.owner.em.execute(
      "update wagering.reference_retries set next_attempt_at=clock_timestamp()-interval '2 seconds' where transaction_id=?",
      [first.body.transactionId],
    );
    await db.owner.em.execute(
      `create function wagering.fail_first_reference() returns trigger language plpgsql as $$ begin if NEW.transaction_id='${first.body.transactionId}' and NEW.event_type='WagerTransactionProcessed' then raise exception 'first candidate failure'; end if; return NEW; end $$`,
    );
    await db.owner.em.execute(
      'create trigger fail_first_reference before insert on wagering.outbox for each row execute function wagering.fail_first_reference()',
    );
    try {
      expect(await runner.runBatch(50)).toBe(1);
      expect(await current(first.body.transactionId)).toMatchObject({
        status: 'PENDING_REFERENCE',
      });
      expect(await current(second.body.transactionId)).toMatchObject({ status: 'PROCESSED' });
      const failed = await schedule(first.body.transactionId);
      expect(failed.attempts).toBe(1);
      expect(new Date(failed.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    } finally {
      await db.owner.em.execute('drop trigger fail_first_reference on wagering.outbox');
      await db.owner.em.execute('drop function wagering.fail_first_reference()');
    }
    await audit(broken.id);
    await audit(healthy.id);
  },
);
