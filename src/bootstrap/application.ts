import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HealthModule } from '../observability/health.module';
import { JsonLogger } from '../observability/logger';
import { loadConfig, type AppConfig } from '../config/config';

export async function createApplication(config: AppConfig = loadConfig()) {
  @Module({ imports: [HealthModule.register(config)] })
  class ApplicationModule {}
  const app = await NestFactory.create(ApplicationModule, { logger: new JsonLogger(), abortOnError: false });
  app.enableShutdownHooks();
  return app;
}
