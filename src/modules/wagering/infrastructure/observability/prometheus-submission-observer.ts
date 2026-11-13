import type { MetricsRegistry } from '../../../../observability/metrics.module';
import type { SubmissionObserver } from '../../application/submit-wager-transaction';

export function submissionMetricsObserver(metrics: MetricsRegistry): SubmissionObserver {
  return {
    completed: ({ operation, channel, status, durationSeconds, idempotentReplay }) => {
      metrics.transactionAttempts.inc({ operation, channel, status });
      metrics.transactionDuration.observe({ operation, channel, status }, durationSeconds);
      if (idempotentReplay) metrics.transactionDuplicates.inc({ operation, channel });
    },
    failed: ({ operation, channel, status, durationSeconds }) => {
      metrics.transactionAttempts.inc({ operation, channel, status });
      metrics.transactionDuration.observe({ operation, channel, status }, durationSeconds);
    },
  };
}
