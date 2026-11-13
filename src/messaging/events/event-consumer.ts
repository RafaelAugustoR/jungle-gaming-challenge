import { createHash } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { parseIntegrationEvent } from './integration-envelope';

export class EventConsumer {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly consumerName = 'demo-wallet-events',
  ) {}
  async accept(body: string): Promise<'processed' | 'duplicate'> {
    const event = parseIntegrationEvent(body);
    const hash = createHash('sha256').update(body).digest('hex');
    return this.orm.em.fork().transactional(async (em) => {
      const inserted = await em.execute(
        `insert into wagering.event_inbox(consumer_name,event_id,payload_hash,aggregate_id,sequence)
        values(?,?,?,?,?) on conflict(consumer_name,event_id) do nothing returning event_id`,
        [this.consumerName, event.eventId, hash, event.aggregateId, event.sequence],
      );
      if (!inserted.length) {
        const [existing] = await em.execute<{ payload_hash: string }[]>(
          'select payload_hash from wagering.event_inbox where consumer_name=? and event_id=?',
          [this.consumerName, event.eventId],
        );
        if (existing?.payload_hash !== hash) throw new Error('EVENT_PAYLOAD_CONFLICT');
        return 'duplicate';
      }
      const balance = event.eventType === 'WalletBalanceChanged' ? event.data.balanceAfter : null;
      const version = event.eventType === 'WalletBalanceChanged' ? event.data.walletVersion : null;
      await em.execute(
        `insert into wagering.event_projection as p(consumer_name,aggregate_id,sequence,event_id,event_type,balance,wallet_version)
        values(?,?,?,?,?,?::jsonb,?) on conflict(consumer_name,aggregate_id) do update set
        sequence=greatest(p.sequence,excluded.sequence),
        event_id=case when excluded.sequence>p.sequence then excluded.event_id else p.event_id end,
        event_type=case when excluded.sequence>p.sequence then excluded.event_type else p.event_type end,
        balance=case when excluded.wallet_version>coalesce(p.wallet_version,0) then excluded.balance else p.balance end,
        wallet_version=greatest(p.wallet_version,excluded.wallet_version)`,
        [
          this.consumerName,
          event.aggregateId,
          event.sequence,
          event.eventId,
          event.eventType,
          balance ? JSON.stringify(balance) : null,
          version,
        ],
      );
      return 'processed';
    });
  }
  async runOnce(signal?: AbortSignal): Promise<number> {
    const result = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
        VisibilityTimeout: 30,
      }),
      { abortSignal: signal ?? AbortSignal.timeout(10000) },
    );
    for (const message of result.Messages ?? []) {
      if (!message.Body || !message.ReceiptHandle) throw new Error('INVALID_EVENT_MESSAGE');
      await this.accept(message.Body);
      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
    }
    return result.Messages?.length ?? 0;
  }
}
