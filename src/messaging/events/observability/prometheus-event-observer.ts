import type { MetricsRegistry } from '../../../observability/metrics.module';
import type { EventConsumerObserver } from '../event-consumer';

export function eventConsumerMetricsObserver(metrics: MetricsRegistry): EventConsumerObserver {
  return { dlqDepth: (depth) => metrics.dlqMessages.set({ worker: 'event-consumer' }, depth) };
}
