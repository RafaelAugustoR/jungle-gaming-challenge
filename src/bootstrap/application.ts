import 'reflect-metadata';
import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readiness } from '../observability/readiness';

@Controller('health')
class HealthController {
  @Get('live')
  live() { return { status: 'ok' }; }
  @Get('ready')
  async ready() {
    const checks = await readiness();
    if (!checks.postgres || !checks.sqs) throw new ServiceUnavailableException({ status: 'unavailable', checks });
    return { status: 'ok', checks };
  }
}

@Module({ controllers: [HealthController] })
class ApplicationModule {}

export async function createApplication() {
  const app = await NestFactory.create(ApplicationModule, { logger: false });
  app.enableShutdownHooks();
  return app;
}
