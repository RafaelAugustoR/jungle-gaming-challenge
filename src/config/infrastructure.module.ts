import { DynamicModule, Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from './config';
import { openDatabase } from './orm';
import { createSqsClient } from './sqs';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Injectable()
class InfrastructureLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM, @Inject(SQSClient) private readonly sqs: SQSClient) {}
  async onApplicationShutdown() {
    this.sqs.destroy();
    await this.orm.close(true);
  }
}

@Global()
@Module({})
export class InfrastructureModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: InfrastructureModule,
      providers: [
        { provide: APP_CONFIG, useValue: Object.freeze({ ...config }) },
        { provide: MikroORM, useFactory: () => openDatabase(config) },
        { provide: SQSClient, useFactory: () => createSqsClient(config) },
        InfrastructureLifecycle,
      ],
      exports: [APP_CONFIG, MikroORM, SQSClient],
    };
  }
}
