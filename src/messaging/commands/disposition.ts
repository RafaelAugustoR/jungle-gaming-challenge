import { DomainError } from '../../shared/domain/errors/domain-error';
import { InboxConflict } from './inbox-conflict';
export interface CommandLogContext {
  messageId: string;
  transportMessageId: string;
  correlationId: string;
  providerId?: string;
  walletId?: string;
  transactionId?: string;
}
export type FailureDisposition =
  | { kind: 'deadLetter'; reason: string }
  | { kind: 'retry'; reason: string };
export type Disposition = ({ kind: 'ack' } | FailureDisposition) & { context: CommandLogContext };
export function classify(error: unknown): FailureDisposition {
  if (error instanceof InboxConflict) return { kind: 'deadLetter', reason: error.code };
  if (error instanceof DomainError) {
    const kind =
      error.category === 'internal' || error.category === 'unavailable' ? 'retry' : 'deadLetter';
    return { kind, reason: error.code };
  }
  return { kind: 'retry', reason: 'PROCESSING_UNAVAILABLE' };
}
