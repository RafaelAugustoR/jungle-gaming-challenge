import { integer } from '../../config/integer';
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
  const config = {
    ...loadEventConfig(env),
    leaseMs: integer(env, 'OUTBOX_LEASE_MS', 30000, 600000),
    sendTimeoutMs: integer(env, 'OUTBOX_SEND_TIMEOUT_MS', 5000, 60000),
    batchSize: integer(env, 'OUTBOX_BATCH_SIZE', 20, 100),
    retryBaseMs: integer(env, 'OUTBOX_RETRY_BASE_MS', 1000, 60000),
    retryMaxMs: integer(env, 'OUTBOX_RETRY_MAX_MS', 60000, 3600000),
  };
  if (config.sendTimeoutMs >= config.leaseMs || config.retryMaxMs < config.retryBaseMs)
    throw new Error('Invalid outbox timing');
  return config;
}

export function loadEventConfig(env: Record<string, string | undefined> = process.env) {
  const queueName = env.OUTBOX_QUEUE_NAME ?? 'wager-events.fifo';
  const pollMs = integer(env, 'OUTBOX_POLL_MS', 500, 60000);
  if (!/^[A-Za-z0-9_-]{1,71}\.fifo$/.test(queueName)) throw new Error('Invalid OUTBOX_QUEUE_NAME');
  return { queueName, pollMs };
}
