import { Controller, Get, Inject, Module, ServiceUnavailableException } from '@nestjs/common';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG } from '../config/infrastructure.module';
import type { AppConfig } from '../config/config';
import { JsonLogger, safeMessage } from './logger';

@Controller('health')
class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  @Get('live')
  live() {
    return { status: 'ok' };
  }
  @Get('ready')
  async ready() {
    const { orm, sqs } = this;
    const timeout = this.config.probeTimeoutMs;
    const results = await Promise.allSettled([
      (async () => {
        // Driver query deadline is local to this probe, never a session-wide migration timeout.
        await orm.em.getConnection().getKnex().raw('select 1').timeout(timeout, { cancel: true });
      })(),
      sqs.send(new ListQueuesCommand({ MaxResults: 1 }), {
        abortSignal: AbortSignal.timeout(timeout),
      }),
    ]);
    const names = ['postgres', 'sqs'] as const;
    const checks = {
      postgres: results[0].status === 'fulfilled',
      sqs: results[1].status === 'fulfilled',
    };
    results.forEach((result, i) => {
      if (result.status === 'rejected')
        new JsonLogger().warn({
          event: 'readiness_failed',
          dependency: names[i],
          reason: safeMessage(result.reason),
        });
    });
    if (!Object.values(checks).every(Boolean))
      throw new ServiceUnavailableException({ status: 'unavailable', checks });
    return { status: 'ok', checks };
  }
}
@Module({ controllers: [HealthController] })
export class HealthModule {}
