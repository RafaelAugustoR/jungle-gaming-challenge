import {
  Body,
  Controller,
  Get,
  Inject,
  Module,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG } from '../../../config/infrastructure.module';
import type { AppConfig } from '../../../config/config';
import { Identity, IdentityModule, Access, type Principal } from '../../identity/identity.module';
import { apiError } from '../../../shared/rest/api-error';
import { parseUuid } from '../../../shared/rest/parse-uuid';
import { createSubmission } from '../infrastructure/create-submission';
import { SubmitWagerTransaction } from '../application/submit-wager-transaction';
import { WagerQueries } from '../application/wager-queries';
import { WageringRepository } from '../infrastructure/persistence/wagering-repository';
import { identifier, parseWagerCommand } from '../application/wager-contract';
import {
  MetricsModule,
  MetricsRegistry,
  submissionMetricsObserver,
  wageringRepositoryMetricsObserver,
} from '../../../observability/metrics.module';
import { JsonLogger } from '../../../observability/logger';

interface RequestContext {
  principal: Principal;
  correlationId: string;
  headers: Record<string, string | undefined>;
}
@Controller()
@UseGuards(Identity)
class WageringController {
  private readonly logger = new JsonLogger();
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submitTransaction: SubmitWagerTransaction,
    @Inject(WagerQueries) private readonly queries: WagerQueries,
  ) {}
  @Post('wagering/transactions')
  @Access({ provider: true })
  async submit(
    @Body() body: unknown,
    @Req() request: RequestContext,
    @Res({ passthrough: true }) response: { status(value: number): void },
  ) {
    const command = parseWagerCommand(body);
    const key = identifier(request.headers['idempotency-key']);
    if (
      request.principal.kind !== 'provider' ||
      request.principal.providerId !== command.providerId
    )
      throw apiError(403, 'PROVIDER_IDENTITY_MISMATCH');
    const receipt = await this.submitTransaction.execute(
      command,
      key,
      {
        correlationId: request.correlationId,
      },
      { channel: 'http' },
    );
    this.logger.write(receipt.body.status === 'REJECTED' ? 'warn' : 'info', {
      event: 'wager_submission_completed',
      correlationId: request.correlationId,
      providerId: command.providerId,
      walletId: command.walletId,
      transactionId: receipt.body.transactionId,
      operation: command.kind,
      status: receipt.body.status,
      idempotentReplay: receipt.body.idempotentReplay,
      ...(receipt.body.status === 'REJECTED' ? { errorCode: receipt.body.failureCode } : {}),
    });
    response.status(receipt.httpStatus);
    return receipt.body;
  }
  @Get('wagering/transactions/:transactionId')
  @Access({ provider: true, humanRoles: ['viewer'] })
  async get(@Param('transactionId') id: string, @Req() request: RequestContext) {
    return this.queries.get(parseUuid(id), request.principal);
  }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @Access({ provider: true, humanRoles: ['viewer'] })
  async getExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
    @Req() request: RequestContext,
  ) {
    identifier(providerId);
    identifier(externalId);
    return this.queries.getExternal(providerId, externalId, request.principal);
  }
}
@Module({
  imports: [IdentityModule, MetricsModule],
  controllers: [WageringController],
  providers: [
    {
      provide: WageringRepository,
      inject: [MikroORM, APP_CONFIG, MetricsRegistry],
      useFactory: (orm: MikroORM, config: AppConfig, metrics: MetricsRegistry) =>
        new WageringRepository(orm, config, wageringRepositoryMetricsObserver(metrics)),
    },
    {
      provide: WagerQueries,
      inject: [WageringRepository],
      useFactory: (repository: WageringRepository) => new WagerQueries(repository),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [WageringRepository, APP_CONFIG, MetricsRegistry],
      useFactory: (repository: WageringRepository, config: AppConfig, metrics: MetricsRegistry) =>
        createSubmission(repository, config, submissionMetricsObserver(metrics)),
    },
  ],
})
export class WageringModule {}
