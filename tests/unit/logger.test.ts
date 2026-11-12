import { expect, spyOn, test } from 'bun:test';
import { JsonLogger } from '../../src/observability/logger';

test('Nest logger preserves stack/context and structured fields while redacting nested secrets', () => {
  const output = spyOn(console, 'log').mockImplementation(() => {});
  try {
    const logger = new JsonLogger();
    logger.error('failed', 'Error: failure\n at https://user:secret@host/path', 'ExceptionsHandler');
    logger.log({ event: 'readiness_failed', dependency: 'postgres', correlationId: 'request-1', details: { password: 'sensitive' } }, 'Health');
    const first = JSON.parse(String(output.mock.calls[0]![0]));
    expect(first.context).toBe('ExceptionsHandler');
    expect(first.stack).toContain('Error: failure');
    expect(first.stack).not.toContain('secret');
    const second = JSON.parse(String(output.mock.calls[1]![0]));
    expect(second.event).toBe('readiness_failed');
    expect(second.dependency).toBe('postgres');
    expect(second.correlationId).toBe('request-1');
    expect(second.details.password).toBe('[redacted]');
    expect(second.context).toBe('Health');
  } finally { output.mockRestore(); }
});
