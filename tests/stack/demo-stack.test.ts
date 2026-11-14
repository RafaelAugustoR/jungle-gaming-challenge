import { expect, test } from 'bun:test';
import { consoleLogin } from '../support/keycloak';

// Black-box smoke of a running stack (Compose or hosted demo) through its public console origin.
// It exercises the deployed issuer, the server-side provider credentials and the real workers.
const base = (process.env.STACK_URL ?? '').replace(/\/$/, '');
const stack = base ? test : test.skip;
const username = process.env.STACK_USER ?? 'demo-operator';
const password = process.env.STACK_PASSWORD ?? 'demo-only';

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await Bun.sleep(250);
  }
}

stack(
  'demo operator runs race, duplicate and out-of-order scenarios and reconciles',
  async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    const headers = {
      Authorization: `Bearer ${await consoleLogin(base, username, password)}`,
      'Content-Type': 'application/json',
    };
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    const created = await call('POST', '/wallets', {
      playerId: `smoke-${crypto.randomUUID()}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(created.status).toBe(201);
    const walletId = created.body.id as string;

    const race = await call('POST', '/demo/scenarios', { scenario: 'race', walletId });
    expect(race.status).toBe(201);
    const outcomes = race.body.transactions
      .map((item: any) => `${item.httpStatus}:${item.originalReceipt.body.status}`)
      .sort();
    expect(outcomes).toEqual(['200:PROCESSED', '422:REJECTED']);
    expect((await call('GET', `/wallets/${walletId}`)).body.balance).toEqual({
      amount: '20.00',
      currency: 'BRL',
    });

    const duplicate = await call('POST', '/demo/scenarios', {
      scenario: 'duplicate',
      walletId,
      amount: '5.00',
    });
    expect(duplicate.status).toBe(201);
    const ids = new Set(
      duplicate.body.transactions.map((item: any) => item.originalReceipt.body.transactionId),
    );
    expect(ids.size).toBe(1);
    expect(
      duplicate.body.transactions
        .map((item: any) => item.originalReceipt.body.idempotentReplay)
        .sort(),
    ).toEqual([false, true]);

    const outOfOrder = await call('POST', '/demo/scenarios', {
      scenario: 'out-of-order',
      walletId,
      amount: '5.00',
    });
    expect(outOfOrder.status).toBe(201);
    const pending = outOfOrder.body.transactions.find(
      (item: any) => item.originalReceipt.body.status === 'PENDING_REFERENCE',
    );
    expect(pending?.httpStatus).toBe(202);
    const settled = await eventually(
      () => call('GET', `/wagering/transactions/${pending.originalReceipt.body.transactionId}`),
      (current) => current.body.status !== 'PENDING_REFERENCE',
    );
    expect(settled.body.status).toBe('PROCESSED');

    const reconciliation = await call('POST', `/wallets/${walletId}/reconciliation`);
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body).toMatchObject({
      consistent: true,
      storedBalance: { amount: '15.00', currency: 'BRL' },
      calculatedBalance: { amount: '15.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
    });
  },
  60_000,
);
