import { lockWalletRows, waitForWalletLock } from '../support/sql-barrier';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { disposableDatabase } from '../support/database';
import { apiProcess } from '../support/api-cluster';
import { humanToken, providerToken } from '../support/keycloak';
const integration = process.env.INTEGRATION === '1' ? test : test.skip;
let database: Awaited<ReturnType<typeof disposableDatabase>>;
let processes: Awaited<ReturnType<typeof apiProcess>>[] = [];
let demo: string, provider: string;
const evidence: Record<string, unknown> = {};
beforeAll(async () => {
  if (process.env.INTEGRATION !== '1') return;
  database = await disposableDatabase();
  // Sequential startup makes cleanup deterministic even if one process fails.
  for (let i = 0; i < 3; i++) processes.push(await apiProcess(database.config, `bet-test-${i}`));
  [demo, provider] = await Promise.all([humanToken('demo-operator'), providerToken('a')]);
  expect(new Set(processes.map((p) => p.pid)).size).toBe(3);
  evidence.processes = processes.map((p) => ({ pid: p.pid, base: p.base }));
}, 30000);
afterAll(async () => {
  if (process.env.INTEGRATION !== '1') return;
  await Promise.all(processes.map((p) => p.stop()));
  if (process.env.BET_EVIDENCE_PATH)
    await Bun.write(
      process.env.BET_EVIDENCE_PATH,
      JSON.stringify({ at: new Date().toISOString(), ...evidence }, null, 2) + '\n',
    );
  await database?.close();
});
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});
async function wallet() {
  const r = await fetch(`${processes[0]!.base}/wallets`, {
    method: 'POST',
    headers: headers(demo),
    body: JSON.stringify({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    }),
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; playerId: string };
}
function command(w: { id: string; playerId: string }, amount = '80.00') {
  return {
    providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(),
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'round',
    gameId: 'game',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}
async function submit(index: number, body: object, key = crypto.randomUUID()) {
  const r = await fetch(`${processes[index]!.base}/wagering/transactions`, {
    method: 'POST',
    headers: { ...headers(provider), 'Idempotency-Key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
async function state(id: string) {
  const r = await fetch(`${processes[2]!.base}/wallets/${id}`, { headers: headers(demo) });
  return await r.json();
}
async function audit(id: string) {
  // Deliberate schema seam: prove stored/reconstructed equality and pair invariants.
  const [row] = await database.owner.em.execute(
    `select w.balance::text, w.version,
    (select sum(case when credit_account_id=w.account_id then amount else -amount end)::text from wagering.journal where wallet_id=w.id) reconstructed,
    (select count(*)::int from wagering.transactions where wallet_id=w.id and kind='BET') bets,
    (select count(*)::int from wagering.journal j join wagering.transactions t on t.id=j.transaction_id where j.wallet_id=w.id and t.kind='BET') debits,
    (select count(*)::int from wagering.journal where wallet_id=w.id and (amount<=0 or debit_account_id=credit_account_id)) invalid_pairs,
    (select count(*)::int from wagering.submission_receipts r join wagering.transactions t on t.id=r.transaction_id where t.wallet_id=w.id) receipts,
    (select count(*)::int from wagering.outbox where aggregate_id=w.id and event_type='WagerTransactionProcessed') processed_events,
    (select count(*)::int from wagering.outbox where aggregate_id=w.id and event_type='WagerTransactionRejected') rejected_events,
    (select count(*)::int from wagering.outbox where aggregate_id=w.id and event_type='WalletBalanceChanged') balance_events
    from wagering.wallets w where w.id=?`,
    [id],
  );
  return row;
}
async function untilBlocked(_walletId: string, count = 1) {
  await waitForWalletLock(database.owner, count, 'bet-test-');
}

integration(
  'fifty concurrent submissions across three processes debit once and replay survives process restart',
  async () => {
    const w = await wallet(),
      bet = command(w),
      key = crypto.randomUUID();
    const lock = database.owner.em.fork();
    await lock.begin();
    await lockWalletRows(lock, w.id);
    const requests = Array.from({ length: 50 }, (_, i) => submit(i % 3, bet, key));
    try {
      await untilBlocked(w.id, 3);
    } finally {
      await lock.commit();
    }
    const results = await Promise.all(requests);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(results.filter((r) => r.body.idempotentReplay === true)).toHaveLength(49);
    expect(await state(w.id)).toMatchObject({ balance: { amount: '20.00' }, version: 2 });
    const summary = await audit(w.id);
    expect(summary).toEqual({
      balance: '20.00',
      version: 2,
      reconstructed: '20.00',
      bets: 1,
      debits: 1,
      invalid_pairs: 0,
      receipts: 1,
      processed_events: 2, // OPENING + BET
      rejected_events: 0,
      balance_events: 2,
    });
    await processes[0]!.stop();
    processes[0] = await apiProcess(database.config, 'bet-test-0');
    expect(await submit(0, bet, key)).toEqual({
      status: 200,
      body: { ...results[0]!.body, idempotentReplay: true },
    });
    evidence.duplicates = {
      submissions: 50,
      accepted: 1,
      replays: 49,
      ...summary,
      restartPid: processes[0].pid,
    };
  },
  20000,
);

integration(
  'two competing BET 80 on 100 yield one approval, one rejection and balance 20',
  async () => {
    const w = await wallet();
    const lock = database.owner.em.fork();
    await lock.begin();
    await lockWalletRows(lock, w.id);
    const pending = [submit(0, command(w)), submit(1, command(w))];
    try {
      await untilBlocked(w.id, 2);
    } finally {
      await lock.commit();
    }
    const results = await Promise.all(pending);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(results.find((r) => r.status === 422)!.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '20.00' },
    });
    const summary = await audit(w.id);
    expect(summary).toEqual({
      balance: '20.00',
      version: 2,
      reconstructed: '20.00',
      bets: 2,
      debits: 1,
      invalid_pairs: 0,
      receipts: 2,
      processed_events: 2, // OPENING + BET
      rejected_events: 1,
      balance_events: 2,
    });
    evidence.contention = { statuses: results.map((r) => r.status), ...summary };
  },
  15000,
);

integration(
  'a wallet blocked in PostgreSQL does not stop another wallet on a different process',
  async () => {
    const a = await wallet(),
      b = await wallet();
    const lock = database.owner.em.fork();
    await lock.begin();
    await lockWalletRows(lock, a.id);
    let aCompleted = false;
    const pendingA = submit(0, command(a)).then((r) => {
      aCompleted = true;
      return r;
    });
    try {
      await untilBlocked(a.id);
      const resultB = await submit(2, command(b));
      expect(resultB.status).toBe(200);
      expect(aCompleted).toBe(false);
      evidence.independentWallets = { completedWhileOtherLocked: true };
    } finally {
      await lock.commit();
    }
    expect((await pendingA).status).toBe(200);
    expect((await audit(a.id)).reconstructed).toBe('20.00');
    expect((await audit(b.id)).reconstructed).toBe('20.00');
  },
  15000,
);

integration(
  'unique races on different wallets resolve after rollback as key or external identity conflict',
  async () => {
    for (const identity of ['key', 'external']) {
      const a = await wallet(),
        b = await wallet();
      const first = command(a),
        second = command(b);
      const key = crypto.randomUUID();
      if (identity === 'external') second.externalTransactionId = first.externalTransactionId;
      const lock = database.owner.em.fork();
      await lock.begin();
      await lockWalletRows(lock, [a.id, b.id]);
      const pending = [
        submit(0, first, key),
        submit(2, second, identity === 'key' ? key : crypto.randomUUID()),
      ];
      try {
        await untilBlocked(a.id, 2);
      } finally {
        await lock.commit();
      }
      const results = await Promise.all(pending);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body.code).toBe(
        identity === 'key' ? 'IDEMPOTENCY_CONFLICT' : 'EXTERNAL_TRANSACTION_CONFLICT',
      );
      const audits = await Promise.all([audit(a.id), audit(b.id)]);
      expect(audits.map((r) => r.debits).sort()).toEqual([0, 1]);
      expect(audits.every((r) => r.balance === r.reconstructed && r.invalid_pairs === 0)).toBe(
        true,
      );
    }
  },
  15000,
);
