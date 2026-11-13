import { DynamicModule, Module } from '@nestjs/common';
import { InfrastructureModule } from '../../../config/infrastructure.module';
import type { AppConfig } from '../../../config/config';
import { ReferenceRetryPolicy } from '../domain/reference-retry';
import { ReferenceRetryModule } from '../infrastructure/reference-retry.provider';
import { JsonLogger } from '../../../observability/logger';
import { ReprocessReferences } from '../application/reprocess-references';
import { WageringRepository } from '../infrastructure/persistence/wagering-repository';

@Module({})
export class ReferenceWorkerModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: ReferenceWorkerModule,
      imports: [InfrastructureModule.register(config), ReferenceRetryModule],
      providers: [
        WageringRepository,
        {
          provide: ReprocessReferences,
          inject: [WageringRepository, ReferenceRetryPolicy],
          useFactory: (store: WageringRepository, policy: ReferenceRetryPolicy) =>
            new ReprocessReferences(store, policy, (candidate, error) =>
              new JsonLogger().error({ event: 'reference_retry_failed', ...candidate, error }),
            ),
        },
      ],
      exports: [ReprocessReferences],
    };
  }
}
