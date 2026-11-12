import 'reflect-metadata';
import { DynamicModule, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { InfrastructureModule } from '../config/infrastructure.module';
import { HealthModule } from '../observability/health.module';
import { JsonLogger } from '../observability/logger';
import { loadConfig, type AppConfig } from '../config/config';

@Module({})
export class ApiModule {
  static register(config: AppConfig): DynamicModule {
    return { module: ApiModule, imports: [InfrastructureModule.register(config), HealthModule] };
  }
}

export async function createApplication(config: AppConfig = loadConfig()) {
  const app = await NestFactory.create(ApiModule.register(config), { logger: new JsonLogger(), abortOnError: false });
  app.enableShutdownHooks();
  return app;
}
