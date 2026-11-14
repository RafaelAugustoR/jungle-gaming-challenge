import { expect, test } from 'bun:test';
import { HttpException } from '@nestjs/common';
import { loadConfig } from '../../src/config/config';
import { DemoProviderClient } from '../../src/modules/demo/infrastructure/demo-provider-client';

test('demo provider preserves business 4xx and maps dependency authentication/server failures to 503', async () => {
  const client = new DemoProviderClient(
    loadConfig({
      DATABASE_URL: 'postgresql://user:pass@localhost/db',
      SQS_ENDPOINT: 'http://localhost:4566',
    }),
  );
  const command = {
    providerId: 'provider-a',
    externalTransactionId: 'demo-test',
    playerId: 'player-demo',
    walletId: '00000000-0000-4000-8000-000000000001',
    roundId: 'round-demo',
    gameId: 'game-demo',
    kind: 'BET' as const,
    money: { amount: '1.00', currency: 'BRL' },
  };
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [400, 404, 409, 422, 401, 403]) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ code: 'UPSTREAM_REJECTION' }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch;
      let failure: unknown;
      try {
        await client.submit(3000, 'provider-token', command, 'demo-key');
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(HttpException);
      const dependencyFailure = status === 401 || status === 403;
      expect((failure as HttpException).getStatus()).toBe(dependencyFailure ? 503 : status);
      expect((failure as HttpException).getResponse()).toMatchObject({
        code: dependencyFailure ? 'INFRASTRUCTURE_UNAVAILABLE' : 'UPSTREAM_REJECTION',
      });
    }
    globalThis.fetch = (async () =>
      new Response('unavailable', { status: 500 })) as unknown as typeof fetch;
    let serverFailure: unknown;
    try {
      await client.submit(3000, 'provider-token', command, 'demo-key');
    } catch (error) {
      serverFailure = error;
    }
    expect(serverFailure).toBeInstanceOf(HttpException);
    expect((serverFailure as HttpException).getStatus()).toBe(503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
