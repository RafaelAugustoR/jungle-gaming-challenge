import { lockWalletRows } from '../support/sql-barrier';
import { openDatabase } from '../../src/config/orm';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../../src/bootstrap/application';
import { disposableDatabase } from '../support/database';
import { humanToken, providerToken } from '../support/keycloak';
const integration = process.env.INTEGRATION === '1' ? test : test.skip;
let db: Awaited<ReturnType<typeof disposableDatabase>>,
  app: INestApplication,
  base: string,
  human: string,
  provider: string;
beforeAll(async () => {
  if (process.env.INTEGRATION !== '1') return;
  db = await disposableDatabase();
  app = await createApplication(db.config);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  [human, provider] = await Promise.all([humanToken('demo-operator'), providerToken('a')]);
});
afterAll(async () => {
  await app?.close();
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
integration(
  'WIN/LOSS settle with typed events; zero and LOSS preserve wallet version and journal',
  async () => {
    const w = await wallet();
    expect((await submit(command(w, 'WIN', '40.00'))).body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '140.00' },
    });
    for (const kind of ['LOSS', 'WIN', 'BET'])
      expect((await submit(command(w, kind, '0.00'))).status).toBe(200);
    expect((await submit(command(w, 'LOSS', '999.00'))).status).toBe(200);
    expect(await state(w.id)).toMatchObject({ balance: { amount: '140.00' }, version: 2 });
    expect(await audit(w.id)).toMatchObject({ entries: 2 });
    const events = await db.owner.em.execute(
      `select event_type,count(*)::int n from wagering.outbox where aggregate_id=? group by event_type`,
      [w.id],
    );
    expect(events).toContainEqual({ event_type: 'WagerTransactionProcessed', n: 6 }); // + OPENING
    expect(events).toContainEqual({ event_type: 'WalletBalanceChanged', n: 2 });
  },
);
integration(
  'REFUND and direct ROLLBACK may reverse one BET once per kind; rollback of REFUND debits',
  async () => {
    const w = await wallet(),
      bet = command(w, 'BET');
    expect((await submit(bet)).body.balance.amount).toBe('80.00');
    const refund = command(w, 'REFUND', '20.00', bet.externalTransactionId),
      key = crypto.randomUUID();
    const first = await submit(refund, key);
    expect(first.body.balance.amount).toBe('100.00');
    expect(
      (await submit(command(w, 'ROLLBACK', '20.00', bet.externalTransactionId))).body.balance
        .amount,
    ).toBe('120.00');
    expect(
      (await submit(command(w, 'ROLLBACK', '20.00', refund.externalTransactionId))).body.balance
        .amount,
    ).toBe('100.00');
    expect(await submit(refund, key)).toEqual({
      status: 200,
      body: { ...first.body, idempotentReplay: true },
    });
    expect(
      (await submit(command(w, 'REFUND', '20.00', bet.externalTransactionId))).body.failureCode,
    ).toBe('ALREADY_REVERSED');
    const view = (await (
      await fetch(`${base}/wagering/transactions/${first.body.transactionId}`, {
        headers: headers(provider),
      })
    ).json()) as any;
    expect(view.referenceExternalTransactionId).toBe(bet.externalTransactionId);
    expect(view.referenceTransactionId).toBeDefined();
    expect(await audit(w.id)).toMatchObject({ entries: 5 });
  },
);
integration(
  'WIN reference may have a different amount; incompatible and terminal references reject without journal',
  async () => {
    const w = await wallet(),
      bet = command(w, 'BET');
    await submit(bet);
    expect(
      (await submit(command(w, 'WIN', '35.00', bet.externalTransactionId))).body.balance.amount,
    ).toBe('115.00');
    const cases = [
      {
        ...command(w, 'REFUND', '19.00', bet.externalTransactionId),
        code: 'REFERENCE_AMOUNT_MISMATCH',
      },
      {
        ...command(w, 'REFUND', '20.00', bet.externalTransactionId),
        roundId: 'other',
        code: 'REFERENCE_CONTEXT_MISMATCH',
      },
      { ...command(w, 'ROLLBACK'), code: 'REFERENCE_REQUIRED' },
    ];
    for (const { code, ...body } of cases) {
      const result = await submit(body);
      expect(result.status).toBe(422);
      expect(result.body.failureCode).toBe(code);
    }
    const win = command(w, 'WIN');
    await submit(win);
    expect(
      (await submit(command(w, 'REFUND', '20.00', win.externalTransactionId))).body.failureCode,
    ).toBe('REFERENCE_KIND_MISMATCH');
    const rejected = command(w, 'BET', '999.00');
    await submit(rejected);
    expect(
      (await submit(command(w, 'REFUND', '999.00', rejected.externalTransactionId))).body
        .failureCode,
    ).toBe('REFERENCE_NOT_PROCESSED');
    expect(await state(w.id)).toMatchObject({ balance: { amount: '135.00' }, version: 4 });
    expect(await audit(w.id)).toMatchObject({ entries: 4 });
  },
);
integration(
  'rollback of spent WIN is explicitly rejected, but a new reversal can succeed after credit',
  async () => {
    const w = await wallet('0.00'),
      win = command(w, 'WIN', '50.00');
    await submit(win);
    await submit(command(w, 'BET', '50.00'));
    const reversal = command(w, 'ROLLBACK', '50.00', win.externalTransactionId),
      key = crypto.randomUUID();
    const rejected = await submit(reversal, key);
    expect(rejected.status).toBe(422);
    expect(rejected.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    await submit(command(w, 'WIN', '50.00'));
    expect(await submit(reversal, key)).toEqual({
      status: 422,
      body: { ...rejected.body, idempotentReplay: true },
    });
    expect(
      (await submit(command(w, 'ROLLBACK', '50.00', win.externalTransactionId))).body.balance
        .amount,
    ).toBe('0.00');
    expect(await audit(w.id)).toMatchObject({ entries: 4 });
  },
);
integration('credit beyond supported range is an audit-safe rejection', async () => {
  const w = await wallet('9999999999999999.99');
  const result = await submit(command(w, 'WIN', '0.01'));
  expect(result.status).toBe(422);
  expect(result.body.failureCode).toBe('AMOUNT_LIMIT_EXCEEDED');
  expect(await audit(w.id)).toMatchObject({ entries: 1, version: 1 });
});
integration(
  'missing reference is accepted pending and replayable; no scheduler is claimed by this ticket',
  async () => {
    const w = await wallet(),
      body = command(w, 'REFUND', '20.00', 'not-yet-delivered'),
      key = crypto.randomUUID();
    const accepted = await submit(body, key);
    expect(accepted.status).toBe(202);
    expect(accepted.body.status).toBe('PENDING_REFERENCE');
    expect(await submit(body, key)).toEqual({
      status: 202,
      body: { ...accepted.body, idempotentReplay: true },
    });
    expect(await audit(w.id)).toMatchObject({ entries: 1, version: 1 });
  },
);

integration(
  'runtime can bind an absent reference only while completing a pending operation',
  async () => {
    const w = await wallet();
    const referenceExternal = crypto.randomUUID();
    const refund = command(w, 'REFUND', '0.00', referenceExternal);
    const key = crypto.randomUUID();
    const pending = await submit(refund, key);
    expect(pending.status).toBe(202);
    const bet = { ...command(w, 'BET', '0.00'), externalTransactionId: referenceExternal };
    const processed = await submit(bet);
    expect(processed.status).toBe(200);
    const runtime = await openDatabase(db.config);
    try {
      await runtime.em.fork().transactional(async (em) => {
        await lockWalletRows(em, w.id);
        await em.execute(
          "update wagering.transactions set status='PROCESSED',processed_at=clock_timestamp(),reference_transaction_id=? where id=?",
          [processed.body.transactionId, pending.body.transactionId],
        );
        await em.execute(
          `insert into wagering.outbox(event_id,aggregate_id,transaction_id,sequence,event_type,payload)
        select gen_random_uuid(),?, ?, coalesce(max(sequence),0)+1,'WagerTransactionProcessed','{}'::jsonb from wagering.outbox where aggregate_id=?`,
          [w.id, pending.body.transactionId, w.id],
        );
      });
      const current = (await (
        await fetch(`${base}/wagering/transactions/${pending.body.transactionId}`, {
          headers: headers(provider),
        })
      ).json()) as any;
      expect(current).toMatchObject({
        status: 'PROCESSED',
        referenceTransactionId: processed.body.transactionId,
      });
      expect(await submit(refund, key)).toEqual({
        status: 202,
        body: { ...pending.body, idempotentReplay: true },
      });
      expect((await submit(command(w, 'REFUND', '0.00', referenceExternal))).body.failureCode).toBe(
        'ALREADY_REVERSED',
      );
      await expect(
        runtime.em.execute(
          'update wagering.transactions set reference_transaction_id=null where id=?',
          [pending.body.transactionId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await audit(w.id)).toMatchObject({ entries: 1, version: 1 });
    } finally {
      await runtime.close(true);
    }
  },
);
