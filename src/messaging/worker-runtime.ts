import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { workerLoop } from './worker-loop';
import { loadConfig, type AppConfig } from '../config/config';
import { openDatabase } from '../config/orm';
import { createSqsClient } from '../config/sqs';
import { JsonLogger } from '../observability/logger';
import { MetricsRegistry, startMetricsListener } from '../observability/metrics.module';
interface Runner {
  runOnce(): Promise<number>;
  stop?(): void;
}
export async function runWorker(
  name: string,
  create: (deps: {
    orm: MikroORM;
    sqs: SQSClient;
    config: AppConfig;
    signal: AbortSignal;
    metrics: MetricsRegistry;
  }) => Promise<Runner>,
  options: {
    once: boolean;
    pollMs: number;
    config?: AppConfig;
    onReady?: () => void;
    continueWhen?: (processed: number) => boolean;
  },
) {
  const config = options.config ?? loadConfig(),
    orm = await openDatabase(config),
    sqs = createSqsClient(config),
    metrics = new MetricsRegistry(),
    metricsServer = startMetricsListener(metrics, config.metricsPort, config.metricsAllowedNetwork),
    logger = new JsonLogger(),
    shutdown = new AbortController();
  let runner: Runner | undefined;
  const stop = () => {
    shutdown.abort();
    runner?.stop?.();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    runner = await create({ orm, sqs, config, signal: shutdown.signal, metrics });
    logger.log({ event: 'worker_started', worker: name });
    options.onReady?.();
    await workerLoop(runner, {
      once: options.once,
      pollMs: options.pollMs,
      signal: shutdown.signal,
      continueWhen: options.continueWhen,
      onError: (error) => {
        metrics.retries.inc({ component: name, reason: 'iteration_error' });
        logger.error({ event: 'worker_iteration_failed', worker: name, error });
      },
    });
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    sqs.destroy();
    metricsServer?.stop(true);
    await orm.close(true);
    logger.log({ event: 'worker_stopped', worker: name });
  }
}
