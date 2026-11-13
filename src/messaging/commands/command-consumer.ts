import { createHash } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { SubmitWagerTransaction } from '../../modules/wagering/application/submit-wager-transaction';
import { DomainError } from '../../shared/domain/errors/domain-error';
import { JsonLogger } from '../../observability/logger';
import { retryDelay } from '../outbox/publication-policy';
import { commandInboxHash, diagnosticMessageId, parseCommandEnvelope } from './command-envelope';
import { classify, type CommandLogContext, type Disposition } from './disposition';
export interface CommandConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  visibilitySeconds: number;
  callTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  waitSeconds: number;
  drainMs: number;
  financialDeadlineMs: number;
}
export interface CommandConsumerObserver {
  committed?(messageId: string): Promise<void>;
  deadLetterSent?(messageId: string): Promise<void>;
  retryScheduled?(reason: 'message_retry'): void;
  dlqDepth?(depth: number): void;
}
type ReceivedCommand = Message & { MessageId: string; ReceiptHandle: string };
export class CommandConsumer {
  private readonly logger = new JsonLogger();
  private readonly polling = new AbortController();
  private stopping = false;
  private active?: AbortController;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private lastDlqSampleAt = 0;
  constructor(
    private readonly submit: SubmitWagerTransaction,
    private readonly sqs: SQSClient,
    private readonly options: CommandConsumerOptions,
    private readonly observer: CommandConsumerObserver = {},
  ) {}
  stop() {
    this.stopping = true;
    this.polling.abort();
    if (this.active && !this.drainTimer)
      this.drainTimer = setTimeout(() => this.active?.abort(), this.options.drainMs);
  }
  private callOptions(signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.options.callTimeoutMs);
    return { abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout };
  }
  private visibility(message: ReceivedCommand, seconds: number, signal?: AbortSignal) {
    return this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
      this.callOptions(signal),
    );
  }
  async runOnce(): Promise<number> {
    if (this.stopping) return 0;
    let messages: Message[];
    try {
      const response = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.options.queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: this.options.waitSeconds,
          VisibilityTimeout: this.options.visibilitySeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
        this.callOptions(this.polling.signal),
      );
      messages = response.Messages ?? [];
    } catch (error) {
      if (this.stopping) return 0;
      throw error;
    }
    for (const raw of messages) {
      if (!raw.MessageId || !raw.ReceiptHandle) {
        this.logger.warn({ event: 'command_invalid_transport_metadata' });
        continue;
      }
      const message: ReceivedCommand = {
        ...raw,
        MessageId: raw.MessageId,
        ReceiptHandle: raw.ReceiptHandle,
      };
      if (this.stopping) {
        await this.visibility(message, 0).catch(() => undefined);
        continue;
      }
      const disposition = await this.withLease(message, (signal) => this.handle(message, signal));
      await this.settle(message, disposition);
    }
    await this.refreshDlqDepth();
    return messages.length;
  }
  private async refreshDlqDepth() {
    if (!this.observer.dlqDepth || Date.now() - this.lastDlqSampleAt < 5000) return;
    this.lastDlqSampleAt = Date.now();
    try {
      const { Attributes } = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.options.dlqUrl,
          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
            'ApproximateNumberOfMessagesDelayed',
          ],
        }),
        this.callOptions(),
      );
      const depth = (
        [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ] as const
      ).reduce((total, name) => total + Number(Attributes?.[name] ?? 0), 0);
      if (Number.isFinite(depth)) this.observer.dlqDepth(depth);
    } catch {
      // Keep the last approximate depth when SQS cannot answer; worker health is reported separately.
    }
  }
  private async withLease(
    message: ReceivedCommand,
    handle: (signal: AbortSignal) => Promise<Disposition>,
  ): Promise<Disposition> {
    const work = new AbortController();
    this.active = work;
    const deadline = setTimeout(() => work.abort(), this.options.financialDeadlineMs);
    let renewal: Promise<unknown> | undefined;
    const heartbeat = setInterval(
      () => {
        if (renewal || work.signal.aborted) return;
        renewal = this.visibility(message, this.options.visibilitySeconds, work.signal)
          .catch(() => work.abort())
          .finally(() => {
            renewal = undefined;
          });
      },
      Math.max(100, (this.options.visibilitySeconds * 1000) / 3),
    );
    try {
      const disposition = await handle(work.signal);
      // The observer coordinates a real post-commit/pre-ack process crash in tests.
      if (disposition.kind === 'ack')
        await this.observer.committed?.(disposition.context.messageId);
      return disposition;
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      clearTimeout(this.drainTimer);
      await renewal;
      this.drainTimer = undefined;
      this.active = undefined;
    }
  }
  private async handle(message: ReceivedCommand, signal: AbortSignal): Promise<Disposition> {
    const messageId = diagnosticMessageId(message.Body ?? '') ?? message.MessageId;
    const context: CommandLogContext = {
      messageId,
      correlationId: messageId,
      transportMessageId: message.MessageId,
    };
    try {
      const envelope = parseCommandEnvelope(message.Body ?? '');
      Object.assign(context, {
        providerId: envelope.command.providerId,
        walletId: envelope.command.walletId,
      });
      if (message.Attributes?.MessageGroupId !== envelope.command.walletId)
        throw new DomainError('INVALID_PAYLOAD');
      const receipt = await this.submit.execute(
        envelope.command,
        envelope.key,
        { correlationId: messageId, causationId: messageId },
        {
          inbox: {
            consumerName: 'wager-commands',
            messageId,
            hash: commandInboxHash(envelope.command, envelope.key),
          },
          signal,
          channel: 'sqs',
        },
      );
      context.transactionId = receipt.body.transactionId;
      return { kind: 'ack', context };
    } catch (error) {
      return { ...classify(error), context };
    }
  }
  private async settle(message: ReceivedCommand, disposition: Disposition) {
    try {
      if (disposition.kind === 'retry') {
        this.logger.warn({
          event: 'command_retry',
          reason: disposition.reason,
          ...disposition.context,
        });
        await this.retry(message);
        return;
      }
      if (disposition.kind === 'deadLetter') await this.deadLetter(message, disposition);
      // Ack failures are transport retries regardless of the prior disposition.
      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
        this.callOptions(),
      );
      this.logger.write(disposition.kind === 'ack' ? 'info' : 'warn', {
        event: disposition.kind === 'ack' ? 'command_committed' : 'command_dead_lettered',
        ...disposition.context,
        ...(disposition.kind === 'deadLetter' ? { reason: disposition.reason } : {}),
      });
    } catch {
      this.logger.warn({
        event: disposition.kind === 'deadLetter' ? 'command_dlq_transfer_failed' : 'command_retry',
        reason: 'TRANSPORT_UNAVAILABLE',
        ...disposition.context,
      });
      await this.retry(message);
    }
  }
  private async deadLetter(
    message: ReceivedCommand,
    disposition: Extract<Disposition, { kind: 'deadLetter' }>,
  ) {
    const identity = createHash('sha256')
      .update(JSON.stringify([this.options.queueUrl, message.MessageId]))
      .digest('hex');
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageGroupId: identity,
        MessageDeduplicationId: identity,
        MessageBody: JSON.stringify({
          originalMessageId: disposition.context.messageId,
          transportMessageId: message.MessageId,
          reason: disposition.reason,
          originalBody: message.Body ?? '',
        }),
      }),
      this.callOptions(),
    );
    await this.observer.deadLetterSent?.(disposition.context.messageId);
  }
  private async retry(message: ReceivedCommand) {
    const attempts = Math.max(1, Number(message.Attributes?.ApproximateReceiveCount ?? 1));
    const seconds = this.stopping
      ? 0
      : Math.max(1, Math.ceil(retryDelay(attempts, this.options) / 1000));
    // Financial work/cancellation has finished before returning visibility.
    await this.visibility(message, seconds).catch(() => undefined);
    if (!this.stopping) this.observer.retryScheduled?.('message_retry');
  }
}
