import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../../src/bootstrap/application';
import { decodeJwt } from 'jose';
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
  'ledger cursor keeps its captured wallet version while new entries arrive',
  async () => {
    const demo = await humanToken('demo-operator');
    const viewer = await humanToken('viewer');
    const provider = await providerToken('a');
    const headers = (token: string) => ({
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    });
    const created = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: headers(demo),
      body: JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    const wallet = (await created.json()) as { id: string; playerId: string };
    const wager = async (amount: string) => {
      const response = await fetch(`${base}/wagering/transactions`, {
        method: 'POST',
        headers: { ...headers(provider), 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          providerId: 'provider-a',
          externalTransactionId: crypto.randomUUID(),
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'cursor-round',
          gameId: 'cursor-game',
          kind: 'BET',
          money: { amount, currency: 'BRL' },
        }),
      });
      expect(response.status).toBe(200);
    };
    await wager('10.00');
    await wager('5.00');

    const first = await fetch(`${base}/wallets/${wallet.id}/ledger?limit=1`, {
      headers: headers(viewer),
    });
    const firstPage = (await first.json()) as {
      entries: { kind: string; walletVersion: number }[];
      nextCursor: string;
    };
    expect(firstPage.entries).toMatchObject([{ kind: 'OPENING', walletVersion: 1 }]);
    expect(firstPage.nextCursor).toBeTruthy();
    await wager('1.00');

    const second = await fetch(
      `${base}/wallets/${wallet.id}/ledger?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      { headers: headers(viewer) },
    );
    const secondPage = (await second.json()) as {
      entries: { kind: string; walletVersion: number }[];
      nextCursor: string | null;
    };
    expect(secondPage.entries).toMatchObject([{ kind: 'BET', walletVersion: 2 }]);
    expect(secondPage.nextCursor).toBeTruthy();
    const third = await fetch(
      `${base}/wallets/${wallet.id}/ledger?limit=1&cursor=${encodeURIComponent(secondPage.nextCursor!)}`,
      { headers: headers(viewer) },
    );
    expect(await third.json()).toMatchObject({
      entries: [{ kind: 'BET', walletVersion: 3 }],
      nextCursor: null,
    });
    const otherCreated = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: headers(demo),
      body: JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '1.00', currency: 'BRL' },
      }),
    });
    const otherWallet = (await otherCreated.json()) as { id: string };
    const crossWalletCursor = await fetch(
      `${base}/wallets/${otherWallet.id}/ledger?cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      { headers: headers(viewer) },
    );
    expect(crossWalletCursor.status).toBe(400);
  },
);

integration('reconciliation is operator-only and reports an exact ledger snapshot', async () => {
  const demo = await humanToken('demo-operator');
  const viewer = await humanToken('viewer');
  const operator = await humanToken('operator');
  const provider = await providerToken('a');
  const create = await fetch(`${base}/wallets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${demo}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '1000000000000000.01', currency: 'BRL' },
    }),
  });
  const wallet = (await create.json()) as { id: string; playerId: string };
  const bet = await fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId: crypto.randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'reconcile-round',
      gameId: 'reconcile-game',
      kind: 'BET',
      money: { amount: '0.02', currency: 'BRL' },
    }),
  });
  expect(bet.status).toBe(200);

  const viewerAttempt = await fetch(`${base}/wallets/${wallet.id}/reconciliation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${viewer}` },
  });
  expect(viewerAttempt.status).toBe(403);
  const response = await fetch(`${base}/wallets/${wallet.id}/reconciliation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${operator}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    walletId: wallet.id,
    storedBalance: { amount: '999999999999999.99', currency: 'BRL' },
    calculatedBalance: { amount: '999999999999999.99', currency: 'BRL' },
    difference: { amount: '0.00', currency: 'BRL' },
    consistent: true,
    checkedEntries: 2,
  });
});

integration('reconciliation reports a privileged fixture divergence, log and metric', async () => {
  const demo = await humanToken('demo-operator');
  const operator = await humanToken('operator');
  const viewer = await humanToken('viewer');
  const created = await fetch(`${base}/wallets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${demo}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '12.34', currency: 'BRL' },
    }),
  });
  const wallet = (await created.json()) as { id: string };
  const scrape = (token?: string) =>
    fetch(`${base}/internal/metrics`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  expect((await scrape()).status).toBe(401);
  const readMetric = async () => {
    const response = await scrape(viewer);
    expect(response.status).toBe(200);
    const exposition = await response.text();
    const value = /^wallet_reconciliation_divergences_total\s+(\d+)$/m.exec(exposition)?.[1];
    expect(value).toBeDefined();
    return Number(value);
  };
  const countBefore = await readMetric();
  await database.owner.em.execute(
    `alter table wagering.wallets disable trigger wallet_consistency;
     update wagering.wallets set balance=7.00 where id=?;
     alter table wagering.wallets enable trigger wallet_consistency`,
    [wallet.id],
  );

  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => logged.push(String(values[0]));
  let response: Response;
  try {
    response = await fetch(`${base}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${operator}` },
    });
  } finally {
    console.log = originalLog;
  }
  expect(response!.status).toBe(200);
  const correlationId = response!.headers.get('x-correlation-id');
  expect(await response!.json()).toMatchObject({
    storedBalance: { amount: '7.00', currency: 'BRL' },
    calculatedBalance: { amount: '12.34', currency: 'BRL' },
    difference: { amount: '-5.34', currency: 'BRL' },
    consistent: false,
    checkedEntries: 1,
  });
  const parsedLogs = logged.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(parsedLogs).toContainEqual(
    expect.objectContaining({
      event: 'wallet_reconciliation_divergence',
      walletId: wallet.id,
      actorId: decodeJwt(operator).sub,
      correlationId,
      checkedEntries: 1,
    }),
  );
  expect(await readMetric()).toBe(countBefore + 1);
  const stillStored = await database.owner.em.execute(
    'select balance::text from wagering.wallets where id=?',
    [wallet.id],
  );
  expect(stillStored).toEqual([{ balance: '7.00' }]);
});

integration('reconciliation formats ledger aggregates beyond the wallet input bound', async () => {
  const demo = await humanToken('demo-operator');
  const operator = await humanToken('operator');
  const created = await fetch(`${base}/wallets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${demo}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '12.34', currency: 'BRL' },
    }),
  });
  const wallet = (await created.json()) as { id: string };
  await database.owner.em.fork().transactional(async (em) => {
    const [owner] = await em.execute<{ account_id: string; currency: string }[]>(
      'select account_id,currency from wagering.wallets where id=?',
      [wallet.id],
    );
    const [gaming] = await em.execute<{ id: string }[]>(
      "select id from wagering.accounts where currency=? and kind='GAMING'",
      [owner!.currency],
    );
    await em.execute('alter table wagering.transactions disable trigger transaction_consistency');
    await em.execute(
      'alter table wagering.transactions disable trigger external_submission_consistency',
    );
    await em.execute('alter table wagering.journal disable trigger journal_consistency');
    for (const walletVersion of [2, 3]) {
      const transactionId = crypto.randomUUID();
      await em.execute(
        `insert into wagering.transactions(id,wallet_id,currency,amount,kind,status,provider_id,external_transaction_id,
           idempotency_key,request_hash,player_id,round_id,game_id,processed_at)
         select ?,?,'BRL','9999999999999999.99','WIN','PROCESSED','divergence',?,?,repeat('a',64),player_id,'round','game',clock_timestamp()
         from wagering.wallets where id=?`,
        [transactionId, wallet.id, transactionId, transactionId, wallet.id],
      );
      await em.execute(
        `insert into wagering.journal(id,transaction_id,wallet_id,currency,amount,debit_account_id,credit_account_id,balance_before,balance_after,wallet_version)
         values(?,?,?,'BRL','9999999999999999.99',?,?,0,'9999999999999999.99',?)`,
        [
          crypto.randomUUID(),
          transactionId,
          wallet.id,
          gaming!.id,
          owner!.account_id,
          walletVersion,
        ],
      );
    }
    await em.execute('set constraints all immediate');
    await em.execute('alter table wagering.journal enable trigger journal_consistency');
    await em.execute(
      'alter table wagering.transactions enable trigger external_submission_consistency',
    );
    await em.execute('alter table wagering.transactions enable trigger transaction_consistency');
  });

  const response = await fetch(`${base}/wallets/${wallet.id}/reconciliation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${operator}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    storedBalance: { amount: '12.34', currency: 'BRL' },
    calculatedBalance: { amount: '20000000000000012.32', currency: 'BRL' },
    difference: { amount: '-19999999999999999.98', currency: 'BRL' },
    consistent: false,
    checkedEntries: 3,
  });
});

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
    const reconciliation = await fetch(`${base}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
      headers,
    });
    expect(reconciliation.status).toBe(200);
    expect(await reconciliation.json()).toMatchObject({
      storedBalance: { amount: '0.00', currency: 'BRL' },
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 0,
    });
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
  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'cursor=garbage', 'cursor=v1.bad']) {
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
