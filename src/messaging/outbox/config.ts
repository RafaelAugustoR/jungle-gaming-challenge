export interface OutboxConfig {
  queueName: string;
  leaseMs: number;
  sendTimeoutMs: number;
  batchSize: number;
  retryBaseMs: number;
  retryMaxMs: number;
  pollMs: number;
}
export function loadOutboxConfig(
  env: Record<string, string | undefined> = process.env,
): OutboxConfig {
  const integer = (key: string, fallback: number, max: number) => {
    const value = env[key] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max)
      throw new Error(`Invalid ${key}`);
    return Number(value);
  };
  const config = {
    ...loadEventConfig(env),
    leaseMs: integer('OUTBOX_LEASE_MS', 30000, 600000),
    sendTimeoutMs: integer('OUTBOX_SEND_TIMEOUT_MS', 5000, 60000),
    batchSize: integer('OUTBOX_BATCH_SIZE', 20, 100),
    retryBaseMs: integer('OUTBOX_RETRY_BASE_MS', 1000, 60000),
    retryMaxMs: integer('OUTBOX_RETRY_MAX_MS', 60000, 3600000),
  };
  if (!/^[A-Za-z0-9_-]{1,75}\.fifo$/.test(config.queueName))
    throw new Error('Invalid OUTBOX_QUEUE_NAME');
  if (config.sendTimeoutMs >= config.leaseMs || config.retryMaxMs < config.retryBaseMs)
    throw new Error('Invalid outbox timing');
  return config;
}

export function loadEventConfig(env: Record<string, string | undefined> = process.env) {
  const queueName = env.OUTBOX_QUEUE_NAME ?? 'wager-events.fifo';
  const pollMs = Number(env.OUTBOX_POLL_MS ?? 500);
  if (!/^[A-Za-z0-9_-]{1,71}\.fifo$/.test(queueName)) throw new Error('Invalid OUTBOX_QUEUE_NAME');
  if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 60000)
    throw new Error('Invalid OUTBOX_POLL_MS');
  return { queueName, pollMs };
}
