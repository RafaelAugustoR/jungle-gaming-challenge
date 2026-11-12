import { Controller, DynamicModule, Get, Inject, Module, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { openDatabase } from '../config/orm';
import { createSqsClient } from '../config/sqs';
import type { AppConfig } from '../config/config';
import { JsonLogger, safeMessage } from './logger';

export class Resources implements OnApplicationShutdown {
  constructor(readonly orm: MikroORM, readonly sqs: SQSClient, readonly timeout: number) {}
  async onApplicationShutdown() { this.sqs.destroy(); await this.orm.close(true); }
}
@Controller('health')
class HealthController {
  constructor(@Inject(Resources) private readonly resources: Resources) {}
  @Get('live')
  live() { return { status: 'ok' }; }
  @Get('ready')
  async ready() {
    const { orm, sqs, timeout } = this.resources;
    const results = await Promise.allSettled([
      (async () => {
        // Driver query deadline is local to this probe, never a session-wide migration timeout.
        await orm.em.getConnection().getKnex().raw('select 1').timeout(timeout, { cancel: true });
      })(),
      sqs.send(new ListQueuesCommand({ MaxResults: 1 }), { abortSignal: AbortSignal.timeout(timeout) }),
    ]);
    const names = ['postgres', 'sqs'] as const;
    const checks = { postgres: results[0].status === 'fulfilled', sqs: results[1].status === 'fulfilled' };
    results.forEach((result, i) => {
      if (result.status === 'rejected') new JsonLogger().warn(`readiness_${names[i]}: ${safeMessage(result.reason)}`);
    });
    if (!Object.values(checks).every(Boolean)) throw new ServiceUnavailableException({ status: 'unavailable', checks });
    return { status: 'ok', checks };
  }
}
@Module({})
export class HealthModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      exports: [Resources],
      providers: [{ provide: Resources, useFactory: async () => {
        const orm = await openDatabase(config);
        return new Resources(orm, createSqsClient(config), config.probeTimeoutMs);
      } }],
    };
  }
}
