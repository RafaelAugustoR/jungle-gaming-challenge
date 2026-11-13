import { loadConfig } from '../src/config/config';
import { openDatabase } from '../src/config/orm';
import { OutboxRepository } from '../src/messaging/outbox/outbox-repository';
import { JsonLogger } from '../src/observability/logger';
const id = process.argv[2];
if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
  throw new Error('Expected event UUID');
const orm = await openDatabase(loadConfig());
try {
  const retried = await new OutboxRepository(orm).retryBlocked(id);
  new JsonLogger().log({ event: 'outbox_operator_retry', eventId: id, retried });
  if (!retried) process.exitCode = 1;
} finally {
  await orm.close(true);
}
