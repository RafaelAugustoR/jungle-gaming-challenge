import { createHash } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig } from '../../config/config';
import { SubmitWagerTransaction } from '../../modules/wagering/application/submit-wager-transaction';
import { ReferenceRetryPolicy } from '../../modules/wagering/domain/reference-retry';
import { WageringRepository } from '../../modules/wagering/infrastructure/persistence/wagering-repository';
import { DomainError } from '../../shared/domain/errors/domain-error';
import { JsonLogger } from '../../observability/logger';
import { diagnosticMessageId, parseCommandEnvelope } from './command-envelope';
export interface CommandConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  visibilitySeconds: number;
  callTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  waitSeconds: number;
  drainMs: number;
}
// Coordination points for the process-level fault harness, never remote commands.
export interface CommandConsumerObserver {
  committed?(messageId: string): Promise<void>;
  deadLetterSent?(messageId: string): Promise<void>;
}
const permanentCodes = new Set([
  'INVALID_PAYLOAD',
  'UNKNOWN_PROVIDER',
  'AMOUNT_LIMIT_EXCEEDED',
  'WALLET_NOT_FOUND',
  'PLAYER_MISMATCH',
  'CURRENCY_MISMATCH',
  'IDEMPOTENCY_CONFLICT',
  'EXTERNAL_TRANSACTION_CONFLICT',
  'INBOX_CONFLICT',
]);
export class CommandConsumer {
  private readonly submit: SubmitWagerTransaction;
  private readonly logger = new JsonLogger();
  private readonly polling = new AbortController();
  private stopping = false;
  private active?: AbortController;
  private drainTimer?: ReturnType<typeof setTimeout>;
  constructor(
    orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly config: AppConfig,
    private readonly options: CommandConsumerOptions,
    private readonly observer: CommandConsumerObserver = {},
  ) {
    this.submit = new SubmitWagerTransaction(
      new WageringRepository(orm, config),
      new Set(Object.values(config.providerClients)),
      new ReferenceRetryPolicy({
        ttlMs: config.referenceTtlMs,
        baseMs: config.referenceBaseMs,
        maxMs: config.referenceMaxMs,
      }),
    );
  }
  stop() {
    this.stopping = true;
    this.polling.abort();
    if (this.active && !this.drainTimer)
      this.drainTimer = setTimeout(() => this.active?.abort(), this.options.drainMs);
  }
  private call<T>(command: { resolveMiddleware: unknown }, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.options.callTimeoutMs);
    return this.sqs.send(command as Parameters<SQSClient['send']>[0], {
      abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }) as Promise<T>;
  }
  private visibility(message: Message, seconds: number) {
    return this.call(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle!,
        VisibilityTimeout: seconds,
      }),
    );
  }
  async runOnce(): Promise<number> {
    if (this.stopping) return 0;
    let messages: Message[];
    try {
      const response = await this.call<{ Messages?: Message[] }>(
        new ReceiveMessageCommand({
          QueueUrl: this.options.queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: this.options.waitSeconds,
          VisibilityTimeout: this.options.visibilitySeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
        this.polling.signal,
      );
      messages = response.Messages ?? [];
    } catch (error) {
      if (this.stopping) return 0;
      throw error;
    }
    for (const message of messages) {
      if (this.stopping) {
        await this.visibility(message, 0).catch(() => undefined);
        continue;
      }
      await this.process(message);
    }
    return messages.length;
  }
  private async process(message: Message) {
    const work = new AbortController();
    this.active = work;
    const deadline = setTimeout(() => work.abort(), this.config.financialDeadlineMs);
    let renewal: Promise<unknown> = Promise.resolve();
    const heartbeat = setInterval(
      () => {
        renewal = renewal
          .then(() => this.visibility(message, this.options.visibilitySeconds))
          .catch(() => work.abort());
      },
      Math.max(100, (this.options.visibilitySeconds * 1000) / 3),
    );
    const settleHeartbeat = async () => {
      clearInterval(heartbeat);
      await renewal;
    };
    let envelope: ReturnType<typeof parseCommandEnvelope> | undefined;
    let committed = false;
    try {
      envelope = parseCommandEnvelope(message.Body ?? '');
      if (message.Attributes?.MessageGroupId !== envelope.command.walletId)
        throw new DomainError('INVALID_PAYLOAD');
      await this.submit.execute(
        envelope.command,
        envelope.key,
        {
          correlationId: envelope.messageId,
          causationId: envelope.messageId,
        },
        {
          inbox: { consumerName: 'wager-commands', messageId: envelope.messageId },
          signal: work.signal,
        },
      );
      committed = true;
      clearTimeout(deadline);
      await this.observer.committed?.(envelope.messageId);
      await settleHeartbeat();
      await this.call(
        new DeleteMessageCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle!,
        }),
      );
      this.logger.log({
        event: 'command_committed',
        messageId: envelope.messageId,
        transportMessageId: message.MessageId,
      });
    } catch (error) {
      await settleHeartbeat();
      // A failed ack (or an uncertain commit) must always be retried, never classified as invalid business.
      if (!committed && error instanceof DomainError && permanentCodes.has(error.code)) {
        const originalMessageId =
          envelope?.messageId ?? diagnosticMessageId(message.Body ?? '') ?? message.MessageId!;
        const identity = createHash('sha256')
          .update(JSON.stringify([this.options.queueUrl, message.MessageId]))
          .digest('hex');
        try {
          await this.call(
            new SendMessageCommand({
              QueueUrl: this.options.dlqUrl,
              MessageGroupId: identity,
              MessageDeduplicationId: identity,
              MessageBody: JSON.stringify({
                originalMessageId,
                transportMessageId: message.MessageId,
                reason: error.code,
                originalBody: message.Body ?? '',
              }),
            }),
          );
          await this.observer.deadLetterSent?.(originalMessageId);
          await this.call(
            new DeleteMessageCommand({
              QueueUrl: this.options.queueUrl,
              ReceiptHandle: message.ReceiptHandle!,
            }),
          );
          this.logger.warn({
            event: 'command_dead_lettered',
            messageId: originalMessageId,
            reason: error.code,
          });
        } catch {
          this.logger.warn({ event: 'command_dlq_transfer_failed', messageId: originalMessageId });
          await this.retry(message);
        }
      } else {
        this.logger.warn({
          event: 'command_retry',
          messageId: envelope?.messageId,
          reason: error instanceof DomainError ? error.code : 'PROCESSING_UNAVAILABLE',
        });
        await this.retry(message);
      }
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
      await settleHeartbeat();
      // Processing and any SQL cancellation/rollback have settled before visibility is returned.
      if (this.stopping) await this.visibility(message, 0).catch(() => undefined);
      this.active = undefined;
    }
  }
  private async retry(message: Message) {
    const attempts = Math.max(1, Number(message.Attributes?.ApproximateReceiveCount ?? 1));
    const cap = Math.min(
      this.options.retryMaxMs,
      this.options.retryBaseMs * 2 ** Math.min(attempts - 1, 16),
    );
    const seconds = Math.max(1, Math.ceil((cap * (0.5 + Math.random() * 0.5)) / 1000));
    await this.visibility(message, seconds).catch(() => undefined);
  }
}
