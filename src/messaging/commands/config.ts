import { integer } from '../../config/integer';
export function loadCommandConfig(env: Record<string, string | undefined> = process.env) {
  const queueName = env.COMMAND_QUEUE_NAME ?? 'wager-transactions.fifo';
  if (!/^[a-zA-Z0-9_-]{1,71}\.fifo$/.test(queueName)) throw new Error('Invalid COMMAND_QUEUE_NAME');
  const config = {
    queueName,
    visibilitySeconds: integer(env, 'COMMAND_VISIBILITY_SECONDS', 30, 43200, 1),
    callTimeoutMs: integer(env, 'COMMAND_CALL_TIMEOUT_MS', 5000, 60000, 100),
    waitSeconds: integer(env, 'COMMAND_WAIT_SECONDS', 2, 20, 0),
    retryBaseMs: integer(env, 'COMMAND_RETRY_BASE_MS', 1000, 30000, 1),
    retryMaxMs: integer(env, 'COMMAND_RETRY_MAX_MS', 30000, 43200000, 1),
    drainMs: integer(env, 'COMMAND_DRAIN_MS', 20000, 60000, 1),
    maxReceiveCount: integer(env, 'COMMAND_MAX_RECEIVE_COUNT', 5, 1000, 1),
  };
  if (config.waitSeconds * 1000 >= config.callTimeoutMs || config.retryBaseMs > config.retryMaxMs)
    throw new Error('Invalid command timeouts');
  return config;
}
