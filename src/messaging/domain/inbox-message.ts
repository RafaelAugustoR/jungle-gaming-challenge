import { DomainError } from '../../shared/domain/errors/domain-error';

export interface InboxMessageProps {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: string;
}
export interface InboxMessageState extends InboxMessageProps {
  processedAt?: string;
  transactionId?: string;
}

/**
 * A consumed command message. Its identity is (consumerName, messageId); the payload hash
 * tells a redelivery apart from a different message reusing the same id. The inbox records a
 * message only once processed, in the same database transaction as the effect it produced.
 */
export class InboxMessage {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly receivedAt: string;
  private processed?: { at: string; transactionId?: string };
  private constructor(state: InboxMessageState) {
    this.consumerName = state.consumerName;
    this.messageId = state.messageId;
    this.payloadHash = state.payloadHash;
    this.receivedAt = state.receivedAt;
    if (state.processedAt)
      this.processed = {
        at: state.processedAt,
        ...(state.transactionId ? { transactionId: state.transactionId } : {}),
      };
  }
  static receive(props: InboxMessageProps): InboxMessage {
    const { consumerName, messageId, payloadHash, receivedAt } = props;
    if (
      typeof consumerName !== 'string' ||
      !consumerName.trim() ||
      typeof messageId !== 'string' ||
      !messageId.trim() ||
      typeof payloadHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(payloadHash) ||
      typeof receivedAt !== 'string' ||
      !Number.isFinite(Date.parse(receivedAt))
    )
      throw new DomainError('INVALID_PAYLOAD');
    return new InboxMessage({ consumerName, messageId, payloadHash, receivedAt });
  }
  /** Restores persisted state as-is; persistence already enforced the invariants. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state);
  }
  get processedAt(): string | undefined {
    return this.processed?.at;
  }
  /** The wager transaction this message created or replayed, once processed. */
  get transactionId(): string | undefined {
    return this.processed?.transactionId;
  }
  isProcessed(): boolean {
    return this.processed !== undefined;
  }
  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }
  markProcessed(at: string, transactionId?: string): this {
    if (this.processed) throw new DomainError('INVALID_MESSAGE_TRANSITION');
    this.processed = { at, ...(transactionId ? { transactionId } : {}) };
    return this;
  }
}
