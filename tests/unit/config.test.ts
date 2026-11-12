import { expect, test } from 'bun:test';
import { loadConfig } from '../../src/config/config';
import { safeMessage } from '../../src/observability/logger';
const env = { DATABASE_URL: 'postgresql://user:secret@localhost/db', SQS_ENDPOINT: 'http://localhost:4566' };
test('configuration rejects invalid ports and missing URLs without exposing credentials', () => {
  for (const PORT of ['0', '65536', 'abc', '3.5', '']) expect(() => loadConfig({ ...env, PORT })).toThrow('Invalid PORT');
  expect(() => loadConfig({})).toThrow('DATABASE_URL');
  expect(() => loadConfig({ ...env, AWS_ACCESS_KEY_ID: 'test' })).toThrow('together');
  expect(safeMessage(new Error(`Cannot connect ${env.DATABASE_URL}`))).not.toContain('secret');
});
