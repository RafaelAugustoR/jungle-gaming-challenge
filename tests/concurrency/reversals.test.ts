import { afterAll, beforeAll, expect, test } from 'bun:test';
import { disposableDatabase } from '../support/database';
import { apiProcess } from '../support/api-cluster';
import { humanToken, providerToken } from '../support/keycloak';
const integration = process.env.INTEGRATION === '1' ? test : test.skip;
let db: Awaited<ReturnType<typeof disposableDatabase>>,
  processes: Awaited<ReturnType<typeof apiProcess>>[] = [];
let human: string, provider: string;
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});
beforeAll(async () => {
  if (process.env.INTEGRATION !== '1') return;
  db = await disposableDatabase();
  for (let i = 0; i < 3; i++) processes.push(await apiProcess(db.config, `reversal-test-${i}`));
  [human, provider] = await Promise.all([humanToken('demo-operator'), providerToken('a')]);
}, 30000);
afterAll(async () => {
  await Promise.all(processes.map((p) => p.stop()));
  await db?.close();
});
integration(
  'different refund IDs racing across three processes reverse a BET exactly once',
  async () => {
    expect(new Set(processes.map((p) => p.pid)).size).toBe(3);
    const response = await fetch(`${processes[0]!.base}/wallets`, {
      method: 'POST',
      headers: headers(human),
      body: JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    const w = (await response.json()) as { id: string; playerId: string };
    expect(response.status).toBe(201);
    const bet = {
      providerId: 'provider-a',
      externalTransactionId: crypto.randomUUID(),
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'round',
      gameId: 'game',
      kind: 'BET',
      money: { amount: '20.00', currency: 'BRL' },
    };
    const submit = async (i: number, body: object) => {
      const r = await fetch(`${processes[i]!.base}/wagering/transactions`, {
        method: 'POST',
        headers: { ...headers(provider), 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as any };
    };
    expect((await submit(0, bet)).status).toBe(200);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        submit(i % 3, {
          ...bet,
          kind: 'REFUND',
          externalTransactionId: crypto.randomUUID(),
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 422 && r.body.failureCode === 'ALREADY_REVERSED'),
    ).toHaveLength(11);
    const [row] = await db.owner.em.execute(
      `select w.balance::text balance,w.version,(select count(*)::int from wagering.journal j join wagering.transactions t on t.id=j.transaction_id where j.wallet_id=w.id and t.kind='REFUND') refunds,(select sum(case when credit_account_id=w.account_id then amount else -amount end)::text from wagering.journal where wallet_id=w.id) reconstructed from wagering.wallets w where id=?`,
      [w.id],
    );
    expect(row).toEqual({ balance: '100.00', version: 3, refunds: 1, reconstructed: '100.00' });
    const [processed] = await db.owner.em.execute(
      `select id from wagering.transactions where wallet_id=? and kind='REFUND' and status='PROCESSED'`,
      [w.id],
    );
    // The database must enforce the same uniqueness even when the application is bypassed.
    await expect(
      db.owner.em.execute(
        `insert into wagering.transactions(id,wallet_id,currency,amount,kind,status,provider_id,external_transaction_id,idempotency_key,request_hash,player_id,round_id,game_id,created_at,processed_at,reference_external_transaction_id,reference_transaction_id)
 select gen_random_uuid(),wallet_id,currency,amount,kind,status,provider_id,?, ?,request_hash,player_id,round_id,game_id,created_at,processed_at,reference_external_transaction_id,reference_transaction_id from wagering.transactions where id=?`,
        [crypto.randomUUID(), crypto.randomUUID(), processed.id],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'one_reversal_per_kind' });
  },
  30000,
);
