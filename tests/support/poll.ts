export async function retryUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 8000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (done(value)) return value;
    await Bun.sleep(25);
  } while (Date.now() < end);
  throw new Error('Condition did not become true');
}
