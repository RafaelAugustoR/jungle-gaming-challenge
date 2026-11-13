import { isUuid } from '../src/shared/domain/is-uuid';
import { loadConfig } from '../src/config/config';
import { openDatabase } from '../src/config/orm';
import { OutboxRepository } from '../src/messaging/outbox/outbox-repository';
import { JsonLogger } from '../src/observability/logger';
const id = process.argv[2];
if (!isUuid(id)) throw new Error('Expected event UUID');
const orm = await openDatabase(loadConfig());
try {
  const retried = await new OutboxRepository(orm).retryBlocked(id);
  new JsonLogger().log({ event: 'outbox_operator_retry', eventId: id, retried });
  if (!retried) process.exitCode = 1;
} finally {
  await orm.close(true);
}
