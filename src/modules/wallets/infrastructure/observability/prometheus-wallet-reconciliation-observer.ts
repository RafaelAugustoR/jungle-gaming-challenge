import { Inject, Injectable } from '@nestjs/common';
import { Counter } from 'prom-client';
import type { WalletReconciliationObserver } from '../../application/wallet-store';
import { MetricsRegistry } from '../../../../observability/metrics.module';
import { JsonLogger } from '../../../../observability/logger';

@Injectable()
export class PrometheusWalletReconciliationObserver implements WalletReconciliationObserver {
  private readonly divergences: Counter<string>;

  constructor(@Inject(MetricsRegistry) metrics: MetricsRegistry) {
    this.divergences = new Counter({
      name: 'wallet_reconciliation_divergences_total',
      help: 'Wallet reconciliations that found a stored balance divergence.',
      registers: [metrics.registry],
    });
  }

  divergence(input: {
    walletId: string;
    actorId?: string;
    correlationId?: string;
    checkedEntries: number;
  }) {
    this.divergences.inc();
    new JsonLogger().warn({
      event: 'wallet_reconciliation_divergence',
      ...input,
    });
  }
}
