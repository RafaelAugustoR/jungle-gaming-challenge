import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { setTimeout } from 'node:timers/promises';
import { loadConfig } from '../config/config';
import { JsonLogger } from '../observability/logger';
import { MetricsRegistry, startMetricsListener } from '../observability/metrics.module';
import { ReprocessReferences } from '../modules/wagering/application/reprocess-references';
import { ReferenceWorkerModule } from '../modules/wagering/scheduler/reference-worker.module';

async function main() {
  const config = loadConfig(),
    logger = new JsonLogger(),
    metrics = new MetricsRegistry(),
    metricsServer = startMetricsListener(metrics, config.metricsPort, config.metricsAllowedNetwork);
  const app = await NestFactory.createApplicationContext(
    ReferenceWorkerModule.register(config, metrics),
    {
      logger,
      abortOnError: false,
    },
  );
  const runner = app.get(ReprocessReferences),
    shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const onMessage = (message: unknown) => {
    if (message === 'stop') stop();
  };
  process.on('message', onMessage);
  process.send?.({ ready: true, pid: process.pid });
  logger.log({ event: 'reference_worker_started', pid: process.pid });
  try {
    while (!shutdown.signal.aborted) {
      try {
        await runner.runBatch(config.referenceBatchSize, shutdown.signal);
      } catch (error) {
        metrics.retries.inc({ component: 'reference', reason: 'batch_error' });
        logger.error(error, undefined, 'ReferenceWorker');
      }
      try {
        await setTimeout(config.referencePollMs, undefined, { signal: shutdown.signal });
      } catch {
        if (!shutdown.signal.aborted) throw new Error('Reference worker timer failed');
      }
    }
  } finally {
    // Drain the current transaction before closing shared connections.
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    process.removeListener('message', onMessage);
    metricsServer?.stop(true);
    await app.close();
    if (process.connected) process.disconnect?.();
  }
}
main().catch((error: unknown) => {
  new JsonLogger().error(error);
  process.exitCode = 1;
});
