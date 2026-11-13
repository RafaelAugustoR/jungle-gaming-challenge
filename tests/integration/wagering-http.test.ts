import { lockWalletRows } from '../support/sql-barrier';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../../src/bootstrap/application';
import { disposableDatabase } from '../support/database';
import { humanToken, providerToken } from '../support/keycloak';

const integration = process.env.INTEGRATION === '1' ? test : test.skip;
let database: Awaited<ReturnType<typeof disposableDatabase>>;
let app: INestApplication;
let base: string;
let demo: string, viewer: string, provider: string, otherProvider: string;
beforeAll(async () => {
  if (process.env.INTEGRATION !== '1') return;
  database = await disposableDatabase();
  app = await createApplication({
    ...database.config,
    financialLockTimeoutMs: 50,
    financialStatementTimeoutMs: 200,
    financialDeadlineMs: 1000,
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  [demo, viewer, provider, otherProvider] = await Promise.all([
    humanToken('demo-operator'),
    humanToken('viewer'),
    providerToken('a'),
    providerToken('b'),
  ]);
});
afterAll(async () => {
  await app?.close();
  await database?.close();
});
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});
async function wallet(amount = '100.00') {
  const response = await fetch(`${base}/wallets`, {
    method: 'POST',
    headers: headers(demo),
    body: JSON.stringify({
      playerId: crypto.randomUUID(),
      initialBalance: { amount, currency: 'BRL' },
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; playerId: string };
}
function command(w: { id: string; playerId: string }, amount = '20.00') {
  return {
    providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(),
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}
async function submit(body: object, key: string = crypto.randomUUID(), token = provider) {
  const response = await fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: { ...headers(token), 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

integration(
  'provider submits BET and reads its current transaction by internal and external identity',
  async () => {
    const w = await wallet();
    const bet = command(w);
    const result = await submit(bet);
    expect(result.status).toBe(200);
    expect(structuredClone(result.body)).toMatchObject({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '80.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    for (const path of [
      `/wagering/transactions/${result.body.transactionId}`,
      `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`,
    ]) {
      const response = await fetch(`${base}${path}`, { headers: headers(provider) });
      const body = await response.json();
      expect({ status: response.status, body }).toMatchObject({
        status: 200,
        body: {
          transactionId: result.body.transactionId,
          kind: 'BET',
          status: 'PROCESSED',
          externalTransactionId: bet.externalTransactionId,
        },
      });
    }
    const read = await fetch(`${base}/wallets/${w.id}`, { headers: headers(viewer) });
    expect(await read.json()).toMatchObject({
      balance: { amount: '80.00', currency: 'BRL' },
      version: 2,
    });
    const ledger = await fetch(`${base}/wallets/${w.id}/ledger`, { headers: headers(viewer) });
    expect(((await ledger.json()) as any).entries).toMatchObject([
      { kind: 'OPENING' },
      {
        kind: 'BET',
        direction: 'DEBIT',
        amount: '20.00',
        balanceBefore: '100.00',
        balanceAfter: '80.00',
        walletVersion: 2,
      },
    ]);
  },
);

integration(
  'canonical replay retains historical balance; changed payload or new key conflicts; providers have independent scope',
  async () => {
    const w = await wallet();
    const bet = command(w);
    const key = crypto.randomUUID();
    const original = await submit(bet, key);
    expect((await submit(command(w, '10.00'))).status).toBe(200);
    const reordered = Object.fromEntries(Object.entries(bet).reverse());
    reordered.money = { currency: 'BRL', amount: '20.00' };
    const repeated = await submit(reordered, key);
    expect(repeated).toEqual({ status: 200, body: { ...original.body, idempotentReplay: true } });
    expect(
      await submit({ ...bet, money: { amount: '21.00', currency: 'BRL' } }, key),
    ).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(await submit(bet)).toMatchObject({
      status: 409,
      body: { code: 'EXTERNAL_TRANSACTION_CONFLICT' },
    });
    expect(await submit({ ...bet, providerId: 'provider-b' }, key, otherProvider)).toMatchObject({
      status: 200,
      body: { balance: { amount: '50.00' }, idempotentReplay: false },
    });
  },
);

integration(
  'insufficient funds retains original 422 receipt and zero changes neither ledger nor version',
  async () => {
    const w = await wallet('10.00');
    const rejected = command(w, '20.00');
    const key = crypto.randomUUID();
    const first = await submit(rejected, key);
    expect(structuredClone(first)).toMatchObject({
      status: 422,
      body: {
        status: 'REJECTED',
        code: 'INSUFFICIENT_FUNDS',
        failureCode: 'INSUFFICIENT_FUNDS',
        correlationId: expect.any(String),
        balance: { amount: '10.00' },
      },
    });
    expect(await submit(command(w, '5.00'))).toMatchObject({
      status: 200,
      body: { balance: { amount: '5.00' } },
    });
    const repeated = await submit(rejected, key);
    const { correlationId: firstCorrelation, ...firstBody } = first.body;
    const { correlationId: nextCorrelation, ...nextBody } = repeated.body;
    expect(repeated.status).toBe(422);
    expect(nextBody).toEqual({ ...firstBody, idempotentReplay: true });
    expect(nextCorrelation).toBe(firstCorrelation);
    const replayResponse = await fetch(`${base}/wagering/transactions`, {
      method: 'POST',
      headers: { ...headers(provider), 'Idempotency-Key': key },
      body: JSON.stringify(rejected),
    });
    expect(replayResponse.headers.get('X-Correlation-Id')).not.toBe(firstCorrelation);
    expect(await replayResponse.json()).toEqual({ ...first.body, idempotentReplay: true });
    const zero = await submit(command(w, '0.00'));
    expect(zero).toMatchObject({
      status: 200,
      body: { status: 'PROCESSED', balance: { amount: '5.00' } },
    });
    const read = await fetch(`${base}/wallets/${w.id}`, { headers: headers(viewer) });
    expect(await read.json()).toMatchObject({ balance: { amount: '5.00' }, version: 2 });
    const ledger = await fetch(`${base}/wallets/${w.id}/ledger`, { headers: headers(viewer) });
    expect(((await ledger.json()) as any).entries).toHaveLength(2);
    const current = await fetch(`${base}/wagering/transactions/${first.body.transactionId}`, {
      headers: headers(provider),
    });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
  },
);

integration(
  'authentication, provider binding and transaction ownership hold on all wagering routes',
  async () => {
    const w = await wallet();
    const bet = command(w);
    for (const token of ['', 'invalid'])
      expect((await submit(bet, crypto.randomUUID(), token)).status).toBe(401);
    for (const token of [demo, viewer, await humanToken('operator'), otherProvider])
      expect((await submit(bet, crypto.randomUUID(), token)).status).toBe(403);
    expect((await submit({ ...bet, providerId: 'unknown' })).status).toBe(403);
    const result = await submit(bet);
    for (const path of [
      `/wagering/transactions/${result.body.transactionId}`,
      `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`,
    ]) {
      for (const token of [otherProvider, viewer, demo]) {
        const read = await fetch(`${base}${path}`, { headers: headers(token) });
        expect(read.status).toBe(token === otherProvider ? 404 : 200);
      }
      expect((await fetch(`${base}${path}`)).status).toBe(401);
    }
    expect(
      (
        await fetch(`${base}/wagering/transactions/${crypto.randomUUID()}`, {
          headers: headers(provider),
        })
      ).status,
    ).toBe(404);
  },
);

integration(
  'invalid financial contracts and missing or incompatible wallet context do not consume the key',
  async () => {
    const w = await wallet();
    const bet = command(w);
    const key = crypto.randomUUID();
    const invalid = [
      { ...bet, kind: 'OPENING' },
      { ...bet, surprise: true },
      { ...bet, referenceExternalTransactionId: null },
      { ...bet, referenceExternalTransactionId: 'other' },
      { ...bet, money: { amount: '0.001', currency: 'BRL' } },
      { ...bet, money: { amount: '1.00', currency: 'BRL', extra: true } },
      { ...bet, money: null },
      { ...bet, roundId: null },
      { ...bet, walletId: 'invalid' },
    ];
    for (const body of invalid)
      expect(await submit(body, key)).toMatchObject({
        status: 400,
        body: { code: 'INVALID_PAYLOAD' },
      });
    const missingKey = await fetch(`${base}/wagering/transactions`, {
      method: 'POST',
      headers: headers(provider),
      body: JSON.stringify(bet),
    });
    expect(missingKey.status).toBe(400);
    expect(await submit({ ...bet, walletId: crypto.randomUUID() }, key)).toMatchObject({
      status: 404,
      body: { code: 'WALLET_NOT_FOUND' },
    });
    expect(await submit({ ...bet, playerId: 'someone-else' }, key)).toMatchObject({
      status: 400,
      body: { code: 'PLAYER_MISMATCH' },
    });
    expect(
      await submit({ ...bet, money: { amount: '20.00', currency: 'USD' } }, key),
    ).toMatchObject({ status: 400, body: { code: 'CURRENCY_MISMATCH' } });
    expect((await submit(bet, key)).status).toBe(200);
  },
);

integration(
  'lock and statement timeouts return sanitized 503, roll back and allow the original key to succeed',
  async () => {
    const w = await wallet(),
      bet = command(w),
      key = crypto.randomUUID();
    const lock = database.owner.em.fork();
    await lock.begin();
    await lockWalletRows(lock, w.id);
    try {
      expect(await submit(bet, key)).toMatchObject({
        status: 503,
        body: { code: 'INFRASTRUCTURE_UNAVAILABLE' },
      });
    } finally {
      await lock.commit();
    }
    expect((await submit(bet, key)).status).toBe(200);
    const next = command(w),
      nextKey = crypto.randomUUID();
    await database.owner.em.execute(
      `create function wagering.test_slow_insert() returns trigger language plpgsql as $$ begin perform pg_sleep(2); return new; end $$; create trigger test_slow_insert before insert on wagering.transactions for each row execute function wagering.test_slow_insert()`,
    );
    try {
      expect(await submit(next, nextKey)).toMatchObject({
        status: 503,
        body: { code: 'INFRASTRUCTURE_UNAVAILABLE' },
      });
    } finally {
      await database.owner.em.execute(
        'drop trigger test_slow_insert on wagering.transactions; drop function wagering.test_slow_insert()',
      );
    }
    expect((await submit(next, nextKey)).status).toBe(200);
  },
);

integration(
  'failures at every financial write boundary leave no partial effects or consumed key',
  async () => {
    const w = await wallet();
    const counts = async () =>
      (
        await database.owner.em.execute(
          `select w.balance::text,w.version,
    (select count(*)::int from wagering.transactions where wallet_id=w.id) transactions,
    (select count(*)::int from wagering.journal where wallet_id=w.id) journal,
    (select count(*)::int from wagering.outbox where aggregate_id=w.id) outbox,
    (select count(*)::int from wagering.submission_receipts r join wagering.transactions t on t.id=r.transaction_id where t.wallet_id=w.id) receipts
    from wagering.wallets w where id=?`,
          [w.id],
        )
      )[0];
    for (const [table, operation] of [
      ['transactions', 'insert'],
      ['journal', 'insert'],
      ['wallets', 'update'],
      ['submission_receipts', 'insert'],
      ['outbox', 'insert'],
    ]) {
      const bet = command(w, '1.00'),
        key = crypto.randomUUID(),
        before = await counts();
      const condition =
        table === 'outbox' ? "when (new.event_type='WagerTransactionProcessed')" : '';
      await database.owner.em.execute(
        `create function wagering.test_write_failure() returns trigger language plpgsql as $$ begin raise exception 'private injected detail'; end $$; create trigger test_write_failure after ${operation} on wagering.${table} for each row ${condition} execute function wagering.test_write_failure()`,
      );
      try {
        const response = await submit(bet, key);
        expect(response).toMatchObject({
          status: 500,
          body: { code: 'INTERNAL_ERROR', message: 'Unexpected error' },
        });
        expect(await counts()).toEqual(before);
      } finally {
        await database.owner.em.execute(
          `drop trigger test_write_failure on wagering.${table}; drop function wagering.test_write_failure()`,
        );
      }
      expect((await submit(bet, key)).status).toBe(200);
    }
  },
);

integration(
  'schema requires the receipt and result event at commit and protects financial facts and terminal states',
  async () => {
    const w = await wallet();
    for (const table of ['submission_receipts', 'outbox']) {
      const bet = command(w),
        key = crypto.randomUUID();
      const skip =
        table === 'outbox'
          ? "if new.event_type='WagerTransactionProcessed' then return null; end if; return new;"
          : 'return null;';
      await database.owner.em.execute(
        `create function wagering.test_skip_write() returns trigger language plpgsql as $$ begin ${skip} end $$; create trigger test_skip_write before insert on wagering.${table} for each row execute function wagering.test_skip_write()`,
      );
      try {
        expect((await submit(bet, key)).status).toBe(500);
      } finally {
        await database.owner.em.execute(
          `drop trigger test_skip_write on wagering.${table}; drop function wagering.test_skip_write()`,
        );
      }
      expect((await submit(bet, key)).status).toBe(200);
    }
    const accepted = await submit(command(w, '1.00'));
    const id = accepted.body.transactionId;
    for (const statement of [
      "update wagering.transactions set status='PENDING' where id=?",
      'update wagering.transactions set amount=2 where id=?',
      "update wagering.transactions set failure_code='EDIT' where id=?",
      'delete from wagering.transactions where id=?',
      'update wagering.submission_receipts set http_status=422 where transaction_id=?',
    ])
      await expect(database.owner.em.fork().execute(statement, [id])).rejects.toMatchObject({
        code: '23514',
      });
    const events = await database.owner.em.execute(
      'select event_type,sequence,payload from wagering.outbox where transaction_id=? order by sequence',
      [id],
    );
    expect(events.map((e: any) => e.event_type)).toEqual([
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
    ]);
    expect(events[1].sequence).toBe(events[0].sequence + 1);
    expect(events[1].payload).toMatchObject({
      eventId: expect.any(String),
      aggregateId: w.id,
      correlationId: expect.any(String),
      eventType: 'WagerTransactionProcessed',
      version: 1,
      occurredAt: expect.any(String),
      data: { transactionId: id, kind: 'BET', money: { amount: '1.00', currency: 'BRL' } },
    });
    const zero = await submit(command(w, '0.00'));
    expect(
      await database.owner.em.execute(
        'select event_type from wagering.outbox where transaction_id=?',
        [zero.body.transactionId],
      ),
    ).toEqual([{ event_type: 'WagerTransactionProcessed' }]);
  },
);

integration(
  'zero opening accepts zero BET and rejects a positive BET without creating financial entries',
  async () => {
    const w = await wallet('0.00');
    expect(await submit(command(w, '0.00'))).toMatchObject({
      status: 200,
      body: { status: 'PROCESSED', balance: { amount: '0.00' } },
    });
    expect(await submit(command(w, '0.01'))).toMatchObject({
      status: 422,
      body: { failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '0.00' } },
    });
    const read = await fetch(`${base}/wallets/${w.id}`, { headers: headers(viewer) });
    expect(await read.json()).toMatchObject({ version: 1, balance: { amount: '0.00' } });
    const ledger = await fetch(`${base}/wallets/${w.id}/ledger`, { headers: headers(viewer) });
    expect(await ledger.json()).toEqual({ entries: [], nextCursor: null });
  },
);

integration(
  'a transient statement timeout retries the whole transaction without duplicating its financial effect',
  async () => {
    const w = await wallet(),
      bet = command(w),
      key = crypto.randomUUID();
    await database.owner.em.execute(`create sequence wagering.test_attempts;
    grant usage on sequence wagering.test_attempts to jungle_runtime;
    create function wagering.test_timeout_once() returns trigger language plpgsql as $$ begin
      if nextval('wagering.test_attempts')=1 then perform pg_sleep(2); end if; return new;
    end $$;
    create trigger test_timeout_once before insert on wagering.transactions for each row execute function wagering.test_timeout_once()`);
    try {
      expect(await submit(bet, key)).toMatchObject({
        status: 200,
        body: { balance: { amount: '80.00' }, idempotentReplay: false },
      });
      expect(
        (await database.owner.em.execute('select last_value::int from wagering.test_attempts'))[0]
          .last_value,
      ).toBe(2);
      const read = await fetch(`${base}/wallets/${w.id}`, { headers: headers(viewer) });
      expect(await read.json()).toMatchObject({ version: 2, balance: { amount: '80.00' } });
    } finally {
      await database.owner.em.execute(
        'drop trigger test_timeout_once on wagering.transactions; drop function wagering.test_timeout_once(); drop sequence wagering.test_attempts',
      );
    }
  },
);

integration(
  'an accepted key conflicts with a changed nonexistent wallet before resource validation',
  async () => {
    const w = await wallet(),
      bet = command(w),
      key = crypto.randomUUID();
    expect((await submit(bet, key)).status).toBe(200);
    const changed = { ...bet, walletId: crypto.randomUUID() };
    expect(await submit(changed, key)).toMatchObject({
      status: 409,
      body: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    expect(await submit(changed)).toMatchObject({
      status: 404,
      body: { code: 'WALLET_NOT_FOUND' },
    });
  },
);

integration(
  'SQL timeout shrinks with the remaining transaction budget after earlier statements consume time',
  async () => {
    const w = await wallet(),
      bet = command(w),
      key = crypto.randomUUID();
    const bounded = await createApplication({
      ...database.config,
      financialDeadlineMs: 600,
      financialStatementTimeoutMs: 1000,
      financialLockTimeoutMs: 50,
    });
    await bounded.listen(0, '127.0.0.1');
    await database.owner.em.execute(`create sequence wagering.test_remaining_limit start 1000;
    grant usage,update on sequence wagering.test_remaining_limit to jungle_runtime;
    create function wagering.test_consume_budget() returns trigger language plpgsql as $$ begin
      if tg_table_name='journal' then perform setval('wagering.test_remaining_limit', (extract(epoch from current_setting('statement_timeout')::interval)*1000)::integer); end if;
      perform pg_sleep(0.35); return new;
    end $$;
    create trigger test_consume_budget before insert on wagering.transactions for each row execute function wagering.test_consume_budget();
    create trigger test_consume_budget before insert on wagering.journal for each row execute function wagering.test_consume_budget()`);
    try {
      const response = await fetch(`${await bounded.getUrl()}/wagering/transactions`, {
        method: 'POST',
        headers: { ...headers(provider), 'Idempotency-Key': key },
        body: JSON.stringify(bet),
      });
      expect(response.status).toBe(503);
      const recorded = (
        await database.owner.em.execute('select last_value::int from wagering.test_remaining_limit')
      )[0].last_value;
      expect(recorded).toBeGreaterThan(1);
      expect(recorded).toBeLessThan(600);
      const read = await fetch(`${base}/wallets/${w.id}`, { headers: headers(viewer) });
      expect(await read.json()).toMatchObject({ balance: { amount: '100.00' }, version: 1 });
    } finally {
      await bounded.close();
      await database.owner.em.execute(
        'drop trigger test_consume_budget on wagering.transactions; drop trigger test_consume_budget on wagering.journal; drop function wagering.test_consume_budget(); drop sequence wagering.test_remaining_limit',
      );
    }
    expect((await submit(bet, key)).status).toBe(200);
  },
  10000,
);
