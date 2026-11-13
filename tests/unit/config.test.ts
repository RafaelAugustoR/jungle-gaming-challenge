import { expect, test } from 'bun:test';
import { loadConfig } from '../../src/config/config';
import { safeMessage } from '../../src/observability/logger';
const env = {
  DATABASE_URL: 'postgresql://user:secret@localhost/db',
  SQS_ENDPOINT: 'http://localhost:4566',
};
test('configuration rejects invalid ports and missing URLs without exposing credentials', () => {
  for (const PORT of ['0', '65536', 'abc', '3.5', ''])
    expect(() => loadConfig({ ...env, PORT })).toThrow('Invalid PORT');
  expect(() => loadConfig({})).toThrow('DATABASE_URL');
  expect(() => loadConfig({ ...env, AWS_ACCESS_KEY_ID: 'test' })).toThrow('together');
  expect(safeMessage(new Error(`Cannot connect ${env.DATABASE_URL}`))).not.toContain('secret');
});

test('provider client mappings are configured and malformed mappings fail at boot', () => {
  expect(
    loadConfig({ ...env, KEYCLOAK_ISSUER: 'http://keycloak:8080/realms/jungle' }).keycloakTokenUrl,
  ).toBe('http://keycloak:8080/realms/jungle/protocol/openid-connect/token');
  expect(
    loadConfig({ ...env, KEYCLOAK_TOKEN_URL: 'http://keycloak:8080/token' }).keycloakTokenUrl,
  ).toBe('http://keycloak:8080/token');
  expect(
    loadConfig({ ...env, PROVIDER_CLIENTS: '{"arcade":"provider-42"}' }).providerClients,
  ).toEqual({ arcade: 'provider-42' });
  for (const PROVIDER_CLIENTS of [
    '{',
    'null',
    '[]',
    '{"arcade":42}',
    '{"jungle-console":"provider"}',
  ]) {
    expect(() => loadConfig({ ...env, PROVIDER_CLIENTS })).toThrow('Invalid PROVIDER_CLIENTS');
  }
  expect(
    loadConfig({
      ...env,
      DEMO_PROVIDER_CLIENT_SECRETS: '{"provider-42":"demo-secret"}',
      PROVIDER_CLIENTS: '{"arcade":"provider-42"}',
    }).demoProvider,
  ).toEqual({ clientId: 'arcade', providerId: 'provider-42', secret: 'demo-secret' });
  expect(loadConfig(env).demoProvider).toBeUndefined();
  expect(() =>
    loadConfig({ ...env, DEMO_PROVIDER_CLIENT_SECRETS: '{"unknown":"secret"}' }),
  ).toThrow('Invalid DEMO_PROVIDER_CLIENT_SECRETS');
});

test('financial time budgets are configurable and reject invalid values', () => {
  expect(loadConfig(env)).toMatchObject({
    financialLockTimeoutMs: 3000,
    financialStatementTimeoutMs: 5000,
    financialDeadlineMs: 15000,
  });
  expect(loadConfig({ ...env, FINANCIAL_LOCK_TIMEOUT_MS: '40' }).financialLockTimeoutMs).toBe(40);
  for (const key of [
    'FINANCIAL_LOCK_TIMEOUT_MS',
    'FINANCIAL_STATEMENT_TIMEOUT_MS',
    'FINANCIAL_DEADLINE_MS',
  ])
    expect(() => loadConfig({ ...env, [key]: '0' })).toThrow(`Invalid ${key}`);
});
