import { ListQueuesCommand } from '@aws-sdk/client-sqs';
import { openDatabase } from '../config/orm';
import { createSqsClient } from '../config/sqs';

export async function readiness() {
  const sqs = createSqsClient();
  const results = await Promise.allSettled([
    (async () => {
      const orm = await openDatabase();
      try { await orm.em.getConnection().execute('select 1'); }
      finally { await orm.close(true); }
    })(),
    sqs.send(new ListQueuesCommand({ MaxResults: 1 })),
  ]);
  sqs.destroy();
  return { postgres: results[0].status === 'fulfilled', sqs: results[1].status === 'fulfilled' };
}
