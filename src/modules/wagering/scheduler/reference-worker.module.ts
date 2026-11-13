import { DynamicModule, Module } from '@nestjs/common';
import { InfrastructureModule, APP_CONFIG } from '../../../config/infrastructure.module';
import type { AppConfig } from '../../../config/config';
import { ReferenceRetryPolicy } from '../domain/reference-retry';
import { ReprocessReferences } from '../application/reprocess-references';
import { WageringRepository } from '../infrastructure/persistence/wagering-repository';

@Module({})
export class ReferenceWorkerModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: ReferenceWorkerModule,
      imports: [InfrastructureModule.register(config)],
      providers: [
        WageringRepository,
        {
          provide: ReprocessReferences,
          inject: [WageringRepository, APP_CONFIG],
          useFactory: (store: WageringRepository, options: AppConfig) =>
            new ReprocessReferences(
              store,
              new ReferenceRetryPolicy({
                ttlMs: options.referenceTtlMs,
                baseMs: options.referenceBaseMs,
                maxMs: options.referenceMaxMs,
              }),
            ),
        },
      ],
      exports: [ReprocessReferences],
    };
  }
}
