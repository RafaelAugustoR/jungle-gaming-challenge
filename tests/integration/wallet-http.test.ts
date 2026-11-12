import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../../src/bootstrap/application';
const integration = process.env.INTEGRATION === '1' ? test : test.skip;
import { disposableDatabase } from '../support/database';
let database: Awaited<ReturnType<typeof disposableDatabase>>;
let app: INestApplication;
let base: string;
beforeAll(async () => {
  if (process.env.INTEGRATION !== '1') return;
  database = await disposableDatabase();
  app = await createApplication(database.config);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await database?.close();
});
integration('wallet HTTP endpoints require a valid access token', async () => {
  for (const token of ['', 'garbage']) {
    const response = await fetch(`${base}/wallets/${crypto.randomUUID()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: 'UNAUTHORIZED',
      correlationId: expect.any(String),
    });
  }
});

import { humanToken, providerToken } from '../support/keycloak';
integration(
  'demo operator creates an exact positive opening and viewer reads its wallet ledger',
  async () => {
    const demo = await humanToken('demo-operator');
    const viewer = await humanToken('viewer');
    const created = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${demo}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    expect(created.status).toBe(201);
    const wallet = (await created.json()) as { id: string };
    expect(wallet).toMatchObject({ balance: { amount: '100.00', currency: 'BRL' }, version: 1 });
    const read = await fetch(`${base}/wallets/${wallet.id}`, {
      headers: { Authorization: `Bearer ${viewer}` },
    });
    expect(await read.json()).toEqual(wallet);
    const ledger = await fetch(`${base}/wallets/${wallet.id}/ledger`, {
      headers: { Authorization: `Bearer ${viewer}` },
    });
    expect(await ledger.json()).toMatchObject({
      entries: [
        {
          kind: 'OPENING',
          direction: 'CREDIT',
          amount: '100.00',
          currency: 'BRL',
          balanceBefore: '0.00',
          balanceAfter: '100.00',
          walletVersion: 1,
        },
      ],
      nextCursor: null,
    });
  },
);

integration(
  'zero opening has version one and no ledger; duplicate player/currency conflicts',
  async () => {
    const token = await humanToken('demo-operator');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const body = JSON.stringify({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    const created = await fetch(`${base}/wallets`, { method: 'POST', headers, body });
    expect(created.status).toBe(201);
    const wallet = (await created.json()) as { id: string };
    expect(wallet).toMatchObject({ balance: { amount: '0.00', currency: 'BRL' }, version: 1 });
    const ledger = await fetch(`${base}/wallets/${wallet.id}/ledger`, { headers });
    expect(await ledger.json()).toEqual({ entries: [], nextCursor: null });
    const duplicate = await fetch(`${base}/wallets`, { method: 'POST', headers, body });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });
  },
);

integration(
  'viewer, operator and both machine providers cannot create wallets; providers cannot read wallets',
  async () => {
    for (const token of [
      await humanToken('viewer'),
      await humanToken('operator'),
      await providerToken('a'),
      await providerToken('b'),
    ]) {
      const response = await fetch(`${base}/wallets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '1.00', currency: 'BRL' },
        }),
      });
      expect(response.status).toBe(403);
    }
    for (const provider of ['a', 'b'] as const) {
      const response = await fetch(`${base}/wallets/${crypto.randomUUID()}`, {
        headers: { Authorization: `Bearer ${await providerToken(provider)}` },
      });
      expect(response.status).toBe(403);
    }
  },
);

integration('wallet HTTP validates payloads, missing wallets and cursor limits', async () => {
  const token = await humanToken('demo-operator');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  for (const initialBalance of [
    { amount: '0.001', currency: 'BRL' },
    { amount: 'NaN', currency: 'BRL' },
    { amount: '-1.00', currency: 'BRL' },
    { amount: '10000000000000000.00', currency: 'BRL' },
    { amount: 1, currency: 'BRL' },
    { amount: '1.00', currency: 'USD' },
    { amount: '1.00', currency: 'BRL', surprise: true },
  ]) {
    expect(
      (
        await fetch(`${base}/wallets`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance }),
        })
      ).status,
    ).toBe(400);
  }
  expect((await fetch(`${base}/wallets/${crypto.randomUUID()}`, { headers })).status).toBe(404);
  expect((await fetch(`${base}/wallets/not-a-uuid`, { headers })).status).toBe(400);
  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'cursor=garbage']) {
    expect(
      (await fetch(`${base}/wallets/${crypto.randomUUID()}/ledger?${query}`, { headers })).status,
    ).toBe(400);
  }
});

integration(
  'outbox persistence failure rolls back the HTTP opening and permits a clean retry',
  async () => {
    const token = await humanToken('demo-operator');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const body = JSON.stringify({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '9999999999999999.99', currency: 'BRL' },
    });
    const counts = async () =>
      (
        await database.owner.em.execute(
          `select (select count(*) from wagering.wallets)::int wallets, (select count(*) from wagering.accounts)::int accounts, (select count(*) from wagering.transactions)::int transactions, (select count(*) from wagering.journal)::int journal, (select count(*) from wagering.outbox)::int outbox`,
        )
      )[0];
    const before = await counts();
    await database.owner.em
      .execute(`create function wagering.test_outbox_failure() returns trigger language plpgsql as $$ begin raise exception 'injected outbox failure'; end $$;
    create trigger test_outbox_failure before insert on wagering.outbox for each statement execute function wagering.test_outbox_failure();`);
    try {
      const failed = await fetch(`${base}/wallets`, { method: 'POST', headers, body });
      expect(failed.status).toBe(500);
      expect(await counts()).toEqual(before);
    } finally {
      await database.owner.em.execute(
        'drop trigger test_outbox_failure on wagering.outbox; drop function wagering.test_outbox_failure()',
      );
    }
    const retried = await fetch(`${base}/wallets`, { method: 'POST', headers, body });
    expect(retried.status).toBe(201);
    expect(await retried.json()).toMatchObject({
      balance: { amount: '9999999999999999.99', currency: 'BRL' },
      version: 1,
    });
  },
);

integration(
  'unrelated unique violations stay internal errors instead of wallet conflicts',
  async () => {
    const token = await humanToken('demo-operator');
    await database.owner.em
      .execute(`create function wagering.test_unique_failure() returns trigger language plpgsql as $$ begin raise exception 'internal collision detail' using errcode='23505', constraint='journal_transaction_id_key'; end $$;
    create trigger test_unique_failure before insert on wagering.accounts for each statement execute function wagering.test_unique_failure();`);
    try {
      const response = await fetch(`${base}/wallets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '1.00', currency: 'BRL' },
        }),
      });
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Unexpected error' });
      expect(JSON.stringify(body)).not.toContain('internal collision detail');
    } finally {
      await database.owner.em.execute(
        'drop trigger test_unique_failure on wagering.accounts; drop function wagering.test_unique_failure()',
      );
    }
  },
);
