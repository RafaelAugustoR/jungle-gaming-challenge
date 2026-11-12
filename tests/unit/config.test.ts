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
});
