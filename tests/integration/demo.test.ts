import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createApplication } from '../../src/bootstrap/application';
import { disposableDatabase } from '../support/database';
import { humanToken } from '../support/keycloak';
import { referenceProcess } from '../support/reference-process';
import { decodeJwt } from 'jose';

const integration = process.env.INTEGRATION === '1' ? test : test.skip;
let database: Awaited<ReturnType<typeof disposableDatabase>>;
let app: Awaited<ReturnType<typeof createApplication>>;
let worker: Awaited<ReturnType<typeof referenceProcess>>;
let base: string;
let demo: string;
let viewer: string;
beforeAll(async () => {
  if (process.env.INTEGRATION !== '1') return;
  database = await disposableDatabase();
  app = await createApplication({
    ...database.config,
    demoProviderClientSecrets: { 'provider-a': 'provider-a-demo-only' },
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  worker = await referenceProcess(database.config);
  [demo, viewer] = await Promise.all([humanToken('demo-operator'), humanToken('viewer')]);
});
afterAll(async () => {
  await worker?.stop();
  await app?.close();
  await database?.close();
});
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

integration(
  'demo operator runs the real out-of-order reference path and audit records actor and provider',
  async () => {
    const playerId = `demo-${crypto.randomUUID()}`;
    const created = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: headers(demo),
      body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    const wallet = (await created.json()) as { id: string };
    expect(created.status).toBe(201);
    const response = await fetch(`${base}/demo/scenarios`, {
      method: 'POST',
      headers: headers(demo),
      body: JSON.stringify({ scenario: 'out-of-order', walletId: wallet.id, amount: '7.25' }),
    });
    const responseBody = await response.text();
    if (response.status !== 201) throw new Error(responseBody);
    expect(response.status).toBe(201);
    const result = JSON.parse(responseBody) as {
      auditId: string;
      providerId: string;
      transactions: Array<{
        httpStatus: number;
        originalReceipt: { status: string };
        current: { status: string };
      }>;
    };
    expect(result.providerId).toBe('provider-a');
    expect(
      result.transactions.map(({ originalReceipt, current }) => ({
        receipt: originalReceipt.status,
        current: current.status,
      })),
    ).toEqual([
      { receipt: 'PENDING_REFERENCE', current: 'PROCESSED' },
      { receipt: 'PROCESSED', current: 'PROCESSED' },
    ]);
    const [audit] = await database.owner.em.execute<
      Array<{
        actor_id: string;
        provider_id: string;
        scenario: string;
        external_transaction_ids: string[];
      }>
    >(
      'select actor_id,provider_id,scenario,external_transaction_ids from demo.scenario_audit where id=?',
      [result.auditId],
    );
    expect(audit).toMatchObject({ provider_id: 'provider-a', scenario: 'out-of-order' });
    expect(audit?.actor_id).toBe(decodeJwt(demo).sub ?? '');
    expect(audit?.external_transaction_ids).toHaveLength(2);
    for (const scenario of [
      { scenario: 'duplicate', amount: '4.00' },
      { scenario: 'race', amount: '60.00' },
    ]) {
      const followUp = await fetch(`${base}/demo/scenarios`, {
        method: 'POST',
        headers: headers(demo),
        body: JSON.stringify({ ...scenario, walletId: wallet.id }),
      });
      expect(followUp.status).toBe(201);
      const value = (await followUp.json()) as {
        transactions: Array<{
          httpStatus: number;
          originalReceipt: { idempotentReplay?: boolean; status: string };
          current: { status: string };
        }>;
      };
      if (scenario.scenario === 'duplicate') {
      expect(
        value.transactions
          .map(({ originalReceipt }) => originalReceipt.idempotentReplay)
          .sort(),
      ).toEqual([false, true]);
        expect(value.transactions.map(({ current }) => current.status)).toEqual([
          'PROCESSED',
          'PROCESSED',
        ]);
      } else {
        expect(value.transactions.map(({ httpStatus }) => httpStatus).sort()).toEqual([200, 422]);
      }
    }
    const forbidden = await fetch(`${base}/demo/scenarios`, {
      method: 'POST',
      headers: headers(viewer),
      body: JSON.stringify({ scenario: 'duplicate', walletId: wallet.id, amount: '1.00' }),
    });
    expect(forbidden.status).toBe(403);
    const invalid = await fetch(`${base}/demo/scenarios`, {
      method: 'POST',
      headers: headers(demo),
      body: JSON.stringify({ scenario: 'kill-process', walletId: wallet.id }),
    });
    expect(invalid.status).toBe(400);
  },
);
