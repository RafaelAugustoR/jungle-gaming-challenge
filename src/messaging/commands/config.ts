export function loadCommandConfig(env: Record<string, string | undefined> = process.env) {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
      throw new Error(`Invalid ${key}`);
    return Number(value);
  };
  const queueName = env.COMMAND_QUEUE_NAME ?? 'wager-transactions.fifo';
  if (!/^[a-zA-Z0-9_-]{1,71}\.fifo$/.test(queueName)) throw new Error('Invalid COMMAND_QUEUE_NAME');
  const config = {
    queueName,
    visibilitySeconds: integer('COMMAND_VISIBILITY_SECONDS', 30, 1, 43200),
    callTimeoutMs: integer('COMMAND_CALL_TIMEOUT_MS', 5000, 100, 60000),
    waitSeconds: integer('COMMAND_WAIT_SECONDS', 2, 0, 20),
    retryBaseMs: integer('COMMAND_RETRY_BASE_MS', 1000, 1, 30000),
    retryMaxMs: integer('COMMAND_RETRY_MAX_MS', 30000, 1, 43200000),
    drainMs: integer('COMMAND_DRAIN_MS', 20000, 1, 60000),
    maxReceiveCount: integer('COMMAND_MAX_RECEIVE_COUNT', 5, 1, 1000),
  };
  if (config.waitSeconds * 1000 >= config.callTimeoutMs || config.retryBaseMs > config.retryMaxMs)
    throw new Error('Invalid command timeouts');
  return config;
}
