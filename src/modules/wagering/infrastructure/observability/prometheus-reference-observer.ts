import type { MetricsRegistry } from '../../../../observability/metrics.module';
import type { ReferenceObserver } from '../../application/reprocess-references';
export function referenceMetricsObserver(metrics: MetricsRegistry): ReferenceObserver {
  return {
    completed: ({ operation, status, durationSeconds }) => {
      metrics.transactionAttempts.inc({ operation, channel: 'reference', status });
      metrics.transactionDuration.observe(
        { operation, channel: 'reference', status },
        durationSeconds,
      );
    },
    failed: ({ operation, status, durationSeconds }) => {
      metrics.transactionAttempts.inc({ operation, channel: 'reference', status });
      metrics.transactionDuration.observe(
        { operation, channel: 'reference', status },
        durationSeconds,
      );
    },
    rescheduled: (reason) => metrics.retries.inc({ component: 'reference', reason }),
    batchFailed: () => metrics.retries.inc({ component: 'reference', reason: 'batch_error' }),
  };
}
