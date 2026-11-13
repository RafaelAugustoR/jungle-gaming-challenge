import { DynamicModule, Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG, InfrastructureModule } from '../../../config/infrastructure.module';
import type { AppConfig } from '../../../config/config';
import { ReferenceRetryPolicy } from '../domain/reference-retry';
import { ReferenceRetryModule } from '../infrastructure/reference-retry.provider';
import { JsonLogger } from '../../../observability/logger';
import { ReprocessReferences } from '../application/reprocess-references';
import { WageringRepository } from '../infrastructure/persistence/wagering-repository';
import {
  MetricsRegistry,
  submissionMetricsObserver,
  wageringRepositoryMetricsObserver,
} from '../../../observability/metrics.module';

@Module({})
export class ReferenceWorkerModule {
  static register(config: AppConfig, metrics: MetricsRegistry): DynamicModule {
    return {
      module: ReferenceWorkerModule,
      imports: [InfrastructureModule.register(config), ReferenceRetryModule],
      providers: [
        { provide: MetricsRegistry, useValue: metrics },
        {
          provide: WageringRepository,
          inject: [MikroORM, APP_CONFIG, MetricsRegistry],
          useFactory: (orm: MikroORM, appConfig: AppConfig, registry: MetricsRegistry) =>
            new WageringRepository(orm, appConfig, wageringRepositoryMetricsObserver(registry)),
        },
        {
          provide: ReprocessReferences,
          inject: [WageringRepository, ReferenceRetryPolicy, MetricsRegistry],
          useFactory: (
            store: WageringRepository,
            policy: ReferenceRetryPolicy,
            registry: MetricsRegistry,
          ) =>
            new ReprocessReferences(
              store,
              policy,
              (candidate, error) => {
                registry.retries.inc({ component: 'reference', reason: 'processing_unavailable' });
                new JsonLogger().error({ event: 'reference_retry_failed', ...candidate, error });
              },
              submissionMetricsObserver(registry),
            ),
        },
      ],
      exports: [ReprocessReferences],
    };
  }
}
