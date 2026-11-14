import { expect, spyOn, test } from 'bun:test';
import { JsonLogger } from '../../src/observability/logger';

test('Nest logger preserves stack/context and structured fields while redacting nested secrets', () => {
  const output = spyOn(console, 'log').mockImplementation(() => {});
  try {
    const logger = new JsonLogger();
    logger.error('failed', 'Error: failure\n at https://user:secret@host/path', 'ExceptionsHandler');
    logger.log({ event: 'readiness_failed', dependency: 'postgres', correlationId: 'request-1', details: { password: 'sensitive' }, payload: { money: { amount: '100.00' } }, balance: '42.00' }, 'Health');
    const first = JSON.parse(String(output.mock.calls[0]![0]));
    expect(first.context).toBe('ExceptionsHandler');
    expect(first.stack).toStartWith('Error\n');
    expect(first.stack).toContain(' at [redacted-url]');
    expect(first.stack).not.toContain('secret');
    const second = JSON.parse(String(output.mock.calls[1]![0]));
    expect(second.event).toBe('readiness_failed');
    expect(second.dependency).toBe('postgres');
    expect(second.correlationId).toBe('request-1');
    expect(second.details.password).toBe('[redacted]');
    expect(second.payload).toBe('[redacted]');
    expect(second.balance).toBe('[redacted]');
    expect(second.context).toBe('Health');
  } finally { output.mockRestore(); }
});

test('database driver errors are reduced to an allowlist without SQL, bound values or detail', async () => {
  const { CheckConstraintViolationException } = await import('@mikro-orm/core');
  const driverError = Object.assign(
    new Error(
      "insert into wagering.journal(id,amount,balance_before,balance_after) values ('j-1', '17.23', '82.77', '100.00') - new row violates check constraint \"journal_amount\"",
    ),
    {
      code: '23514',
      constraint: 'journal_amount',
      table: 'journal',
      detail: 'Failing row contains (17.23, 82.77, 100.00).',
      severity: 'ERROR',
    },
  );
  const wrapped = new CheckConstraintViolationException(driverError);
  const output = spyOn(console, 'log').mockImplementation(() => {});
  try {
    const logger = new JsonLogger();
    logger.error({ event: 'reference_retry_failed', transactionId: 't-1', correlationId: 'c-1', error: wrapped });
    logger.error({ event: 'raw_pg_error', error: driverError });
    logger.error('request failed', wrapped.stack, 'ExceptionsHandler');
    for (const [line] of output.mock.calls) {
      const text = String(line);
      for (const leaked of ['17.23', '82.77', '100.00', 'insert into', 'Failing row'])
        expect(text).not.toContain(leaked);
    }
    const first = JSON.parse(String(output.mock.calls[0]![0]));
    expect(first).toMatchObject({
      event: 'reference_retry_failed',
      transactionId: 't-1',
      correlationId: 'c-1',
      error: { name: 'CheckConstraintViolationException', sqlState: '23514', constraint: 'journal_amount', table: 'journal' },
    });
    expect(first.error.stack).toStartWith('CheckConstraintViolationException\n');
    expect(first.error.stack).toContain(' at ');
    const second = JSON.parse(String(output.mock.calls[1]![0]));
    expect(second.error).toMatchObject({ name: 'Error', sqlState: '23514', constraint: 'journal_amount' });
    expect(JSON.parse(String(output.mock.calls[2]![0])).stack).toStartWith('CheckConstraintViolationException\n');
  } finally { output.mockRestore(); }
});

test('application errors keep code-shaped messages and redact free-text ones', () => {
  const output = spyOn(console, 'log').mockImplementation(() => {});
  try {
    new JsonLogger().error({ event: 'x', error: new Error('INVALID_INTEGRATION_EVENT') });
    new JsonLogger().error({ event: 'y', error: new Error('failed with amount=17.23') });
    expect(JSON.parse(String(output.mock.calls[0]![0])).error.message).toBe('INVALID_INTEGRATION_EVENT');
    expect(String(output.mock.calls[1]![0])).not.toContain('17.23');
  } finally { output.mockRestore(); }
});
