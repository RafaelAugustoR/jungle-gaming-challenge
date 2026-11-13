import type { MetricsRegistry } from '../../../observability/metrics.module';
import type { PublisherObserver } from '../outbox-publisher';

export function publisherMetricsObserver(metrics: MetricsRegistry): PublisherObserver {
  return {
    retryScheduled: (disposition) =>
      metrics.retries.inc({ component: 'outbox', reason: disposition }),
  };
}
