import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiErrorFilter } from '../shared/rest/api-error';
import { resolve } from 'node:path';
import { WalletsModule } from '../modules/wallets/rest/wallets.module';
import { WageringModule } from '../modules/wagering/rest/wagering.module';
import { DemoModule } from '../modules/demo/demo.module';
import { DynamicModule, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { InfrastructureModule } from '../config/infrastructure.module';
import { HealthModule } from '../observability/health.module';
import { JsonLogger } from '../observability/logger';
import { loadConfig, type AppConfig } from '../config/config';
import { MetricsRegistry } from '../observability/metrics.module';

@Module({})
export class ApiModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        InfrastructureModule.register(config),
        HealthModule,
        WalletsModule,
        WageringModule,
        DemoModule,
      ],
    };
  }
}

export async function createApplication(config: AppConfig = loadConfig()) {
  const app = await NestFactory.create<NestExpressApplication>(ApiModule.register(config), {
    logger: new JsonLogger(),
    abortOnError: false,
  });
  const metrics = app.get(MetricsRegistry);
  const logger = new JsonLogger();
  app.use(
    (
      request: { correlationId?: string; method?: string; route?: { path?: string } },
      response: { setHeader: (name: string, value: string) => void; statusCode?: number; on: (event: string, listener: () => void) => void },
      next: () => void,
    ) => {
      request.correlationId = crypto.randomUUID();
      response.setHeader('X-Correlation-Id', request.correlationId);
      const started = performance.now();
      response.on('finish', () => {
        const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(request.method ?? '')
          ? request.method!
          : 'OTHER';
        const route = request.route?.path ?? 'unmatched';
        const status = String(response.statusCode ?? 500);
        metrics.httpRequests.inc({ method, route, status });
        metrics.httpDuration.observe({ method, route }, (performance.now() - started) / 1000);
        logger.write(status.startsWith('5') ? 'error' : 'info', {
          event: 'http_request_completed',
          correlationId: request.correlationId,
          method,
          route,
          statusCode: Number(status),
          durationMs: Math.round(performance.now() - started),
        });
      });
      next();
    },
  );
  app.useStaticAssets(resolve(import.meta.dir, '../../frontend/dist'));
  app
    .getHttpAdapter()
    .get('/console-config', (_request: unknown, response: { json: (value: unknown) => void }) => {
      const issuer = new URL(config.keycloakIssuer);
      const realm = issuer.pathname.split('/').at(-1);
      response.json({ url: issuer.origin, realm, clientId: 'jungle-console' });
    });
  app.useGlobalFilters(new ApiErrorFilter());
  app.enableShutdownHooks();
  return app;
}
