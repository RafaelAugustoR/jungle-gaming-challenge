import { DomainError } from '../../shared/domain/errors/domain-error';

export interface InboxMessageProps {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  /** The wager transaction this message created or replayed. */
  transactionId: string;
}

/**
 * A consumed command message, recorded only together with the effect it produced, in the same
 * database transaction. Its identity is (consumerName, messageId); the payload hash tells a
 * redelivery apart from a different message reusing the same id. It models exactly what the
 * inbox row stores.
 */
export class InboxMessage {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly transactionId: string;
  private constructor(props: InboxMessageProps) {
    this.consumerName = props.consumerName;
    this.messageId = props.messageId;
    this.payloadHash = props.payloadHash;
    this.transactionId = props.transactionId;
  }
  static record(props: InboxMessageProps): InboxMessage {
    const { consumerName, messageId, payloadHash, transactionId } = props;
    if (
      [consumerName, messageId, transactionId].some((v) => typeof v !== 'string' || !v.trim()) ||
      typeof payloadHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(payloadHash)
    )
      throw new DomainError('INVALID_PAYLOAD');
    return new InboxMessage({ consumerName, messageId, payloadHash, transactionId });
  }
}
