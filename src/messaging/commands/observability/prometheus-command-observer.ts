import type { MetricsRegistry } from '../../../observability/metrics.module';
import type { CommandConsumerObserver } from '../command-consumer';

export function commandConsumerMetricsObserver(metrics: MetricsRegistry): CommandConsumerObserver {
  return {
    deadLetterSent: async () => metrics.workerDeadLetters.inc({ worker: 'command' }),
    retryScheduled: () => metrics.retries.inc({ component: 'command', reason: 'message_retry' }),
    dlqDepth: (depth) => metrics.dlqMessages.set({ worker: 'command' }, depth),
  };
}
