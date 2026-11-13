import {
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Module,
  UseGuards,
} from '@nestjs/common';
import { Counter, Registry } from 'prom-client';
import { Identity, IdentityModule, HumanRole } from '../modules/identity/identity.module';
import type { WalletReconciliationObserver } from '../modules/wallets/application/wallet-store';
import { JsonLogger } from './logger';

@Injectable()
export class MetricsRegistry {
  readonly registry = new Registry();
  readonly walletReconciliationDivergences = new Counter({
    name: 'wallet_reconciliation_divergences_total',
    help: 'Wallet reconciliations that found a stored balance divergence.',
    registers: [this.registry],
  });

  scrape() {
    return this.registry.metrics();
  }
}

@Injectable()
export class PrometheusWalletReconciliationObserver implements WalletReconciliationObserver {
  constructor(
    @Inject(MetricsRegistry) private readonly metrics: MetricsRegistry,
  ) {}

  divergence(input: {
    walletId: string;
    actorId?: string;
    correlationId?: string;
    checkedEntries: number;
  }) {
    this.metrics.walletReconciliationDivergences.inc();
    new JsonLogger().warn({
      event: 'wallet_reconciliation_divergence',
      ...input,
    });
  }
}

@Controller('internal')
@UseGuards(Identity)
@HumanRole('viewer')
class MetricsController {
  constructor(@Inject(MetricsRegistry) private readonly metrics: MetricsRegistry) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape() {
    return this.metrics.scrape();
  }
}

@Module({
  imports: [IdentityModule],
  controllers: [MetricsController],
  providers: [MetricsRegistry, PrometheusWalletReconciliationObserver],
  exports: [MetricsRegistry, PrometheusWalletReconciliationObserver],
})
export class MetricsModule {}
