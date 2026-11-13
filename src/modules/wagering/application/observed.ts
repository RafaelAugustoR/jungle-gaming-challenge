import type { WagerKind } from '../domain/wager-command';
import type { TransactionStatus } from '../domain/wager-transaction';

export type ProcessingChannel = 'http' | 'sqs' | 'reference';
export type ObservedOperation = WagerKind | 'unknown';
export type ObservedStatus = TransactionStatus | 'skipped';
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
  failed?(input: { operation: O; channel: C; durationSeconds: number }): void;
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
    observer.failed?.({ ...context, durationSeconds: (performance.now() - startedAt) / 1000 });
    throw error;
  }
}
