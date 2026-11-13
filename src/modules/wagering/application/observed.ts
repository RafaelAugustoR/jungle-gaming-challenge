import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { WagerKind } from '../domain/wager-command';
import type { TransactionStatus } from '../domain/wager-transaction';

export type ProcessingChannel = 'http' | 'sqs' | 'reference';
export type ObservedOperation = WagerKind | 'unknown';
export type ObservedStatus = TransactionStatus | 'skipped';
/** Client-caused failures keep their category; infrastructure and unexpected failures are `error`. */
export type FailureStatus = 'invalid' | 'rejected' | 'forbidden' | 'conflict' | 'notFound' | 'error';
export function failureStatus(error: unknown): FailureStatus {
  if (!(error instanceof DomainError)) return 'error';
  const { category } = error;
  return category === 'unavailable' || category === 'internal' ? 'error' : category;
}
export interface ProcessingObserver<
  C extends ProcessingChannel,
  O extends ObservedOperation,
  S extends ObservedStatus,
> {
  completed?(input: {
    operation: O;
    channel: C;
    status: S;
    durationSeconds: number;
    idempotentReplay: boolean;
  }): void;
  failed?(input: {
    operation: O;
    channel: C;
    status: FailureStatus;
    durationSeconds: number;
  }): void;
}
export async function observed<
  T,
  C extends ProcessingChannel,
  O extends ObservedOperation,
  S extends ObservedStatus,
>(
  observer: ProcessingObserver<C, O, S>,
  context: { channel: C; operation: O },
  run: () => Promise<{ value: T; operation: O; status: S; idempotentReplay?: boolean }>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await run();
    observer.completed?.({
      operation: result.operation,
      channel: context.channel,
      status: result.status,
      durationSeconds: (performance.now() - startedAt) / 1000,
      idempotentReplay: result.idempotentReplay ?? false,
    });
    return result.value;
  } catch (error) {
    observer.failed?.({
      ...context,
      status: failureStatus(error),
      durationSeconds: (performance.now() - startedAt) / 1000,
    });
    throw error;
  }
}
