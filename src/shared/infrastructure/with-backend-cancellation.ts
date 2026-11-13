import type { EntityManager } from '@mikro-orm/postgresql';
export async function withBackendCancellation<T>(
  em: EntityManager,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (!signal) return work();
  signal.throwIfAborted();
  const [{ pid }] = await em.execute<{ pid: number }[]>('select pg_backend_pid() as pid');
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => {
    cancellation = em
      .fork({ keepTransactionContext: false })
      .execute('select pg_cancel_backend(?)', [pid])
      .catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    // Covers an abort between reading the backend PID and registering its listener.
    signal.throwIfAborted();
    return await work();
  } finally {
    signal.removeEventListener('abort', cancel);
    await cancellation;
  }
}
