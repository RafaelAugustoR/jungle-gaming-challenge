import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/infrastructure.module';
import type { AppConfig } from '../../../config/config';
import { ReferenceRetryPolicy } from '../domain/reference-retry';

@Module({
  providers: [
    {
      provide: ReferenceRetryPolicy,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new ReferenceRetryPolicy({
          ttlMs: config.referenceTtlMs,
          baseMs: config.referenceBaseMs,
          maxMs: config.referenceMaxMs,
        }),
    },
  ],
  exports: [ReferenceRetryPolicy],
})
export class ReferenceRetryModule {}
