import type { MetricsRegistry } from '../../../../observability/metrics.module';
import type { WageringRepositoryObserver } from '../persistence/wagering-repository';

export function wageringRepositoryMetricsObserver(
  metrics: MetricsRegistry,
): WageringRepositoryObserver {
  return {
    lockConflict: () => metrics.walletLockConflicts.inc({ source: 'financial' }),
    retry: (reason) => metrics.retries.inc({ component: 'financial', reason }),
  };
}
