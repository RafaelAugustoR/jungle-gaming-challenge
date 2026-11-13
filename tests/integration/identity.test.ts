import { afterAll, beforeAll, expect, test } from 'bun:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../../src/bootstrap/application';
import { loadConfig } from '../../src/config/config';
let app: INestApplication;
let issuer: ReturnType<typeof Bun.serve>;
let base: string;
const keys = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'fixture', alg: 'RS256' };
beforeAll(async () => {
  issuer = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  app = await createApplication({
    ...loadConfig({
      DATABASE_URL: 'postgresql://invalid:invalid@localhost:1/invalid',
      SQS_ENDPOINT: 'http://localhost:1',
    }),
    providerClients: {
      'provider-a': 'provider-a',
      'provider-b': 'provider-b',
      'arcade-machine': 'arcade-provider',
    },
    keycloakIssuer: issuer.url.origin,
    keycloakJwksUrl: issuer.url.href,
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  issuer?.stop(true);
});
async function signed(overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    sub: 'fixture-user',
    iss: issuer.url.origin,
    aud: 'jungle-api',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
    azp: 'jungle-console',
    realm_access: { roles: ['demo-operator'] },
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
    .sign(keys.privateKey);
}
async function post(token: string) {
  return fetch(`${base}/wallets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
}
test('HTTP validates token signature, issuer, audience, expiry and required claims before using roles', async () => {
  expect((await post(await signed())).status).toBe(400); // authenticated request reaches payload validation
  for (const claims of [
    { iss: 'http://another-issuer' },
    { aud: 'another-api' },
    { exp: 1 },
    { exp: undefined },
    { sub: undefined },
  ]) {
    expect((await post(await signed(claims))).status).toBe(401);
  }
  const token = await signed();
  const [header, payload, signature] = token.split('.');
  const tampered = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), sub: 'another-user' })).toString('base64url')}.${signature}`;
  expect((await post(tampered)).status).toBe(401);
});
test('liveness remains public while internal metrics require an authenticated viewer', async () => {
  expect((await fetch(`${base}/health/live`)).status).toBe(200);
  expect((await fetch(`${base}/internal/metrics`)).status).toBe(401);
});
test('HTTP does not trust role-bearing tokens from unrelated clients or providers', async () => {
  for (const claims of [
    { azp: 'other-client' },
    { azp: 'provider-a', providerId: 'provider-b' },
    { azp: 'provider-a', providerId: 'provider-a' },
    { realm_access: { roles: ['viewer'] } },
  ]) {
    expect((await post(await signed(claims))).status).toBe(403);
  }
});

test('malformed JSON returns the stable payload error and correlation ID', async () => {
  const response = await fetch(`${base}/wallets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await signed()}`, 'Content-Type': 'application/json' },
    body: '{',
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    code: 'INVALID_PAYLOAD',
    correlationId: response.headers.get('X-Correlation-Id'),
  });
});

test('configured provider clients are bound to their providerId instead of client name', async () => {
  const mismatched = await post(
    await signed({ azp: 'arcade-machine', providerId: 'other-provider' }),
  );
  expect(mismatched.status).toBe(403);
  expect(await mismatched.json()).toMatchObject({ code: 'PROVIDER_IDENTITY_MISMATCH' });
  const provider = await post(
    await signed({ azp: 'arcade-machine', providerId: 'arcade-provider' }),
  );
  expect(provider.status).toBe(403);
  expect(await provider.json()).toMatchObject({ code: 'FORBIDDEN' });
});
