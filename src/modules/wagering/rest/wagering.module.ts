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
import { APP_CONFIG } from '../../../config/infrastructure.module';
import type { AppConfig } from '../../../config/config';
import { Identity, IdentityModule, Access, type Principal } from '../../identity/identity.module';
import { apiError } from '../../../shared/rest/api-error';
import { parseUuid } from '../../../shared/rest/parse-uuid';
import { ReferenceRetryModule } from '../infrastructure/reference-retry.provider';
import { ReferenceRetryPolicy } from '../domain/reference-retry';
import { SubmitWagerTransaction } from '../application/submit-wager-transaction';
import { WagerQueries } from '../application/wager-queries';
import { WageringRepository } from '../infrastructure/persistence/wagering-repository';
import { identifier, parseWagerCommand } from '../application/wager-contract';

interface RequestContext {
  principal: Principal;
  correlationId: string;
  headers: Record<string, string | undefined>;
}
@Controller()
@UseGuards(Identity)
class WageringController {
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
    const receipt = await this.submitTransaction.execute(command, key, {
      correlationId: request.correlationId,
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
  imports: [IdentityModule, ReferenceRetryModule],
  controllers: [WageringController],
  providers: [
    WageringRepository,
    {
      provide: WagerQueries,
      inject: [WageringRepository],
      useFactory: (repository: WageringRepository) => new WagerQueries(repository),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [WageringRepository, APP_CONFIG, ReferenceRetryPolicy],
      useFactory: (
        repository: WageringRepository,
        config: AppConfig,
        policy: ReferenceRetryPolicy,
      ) =>
        new SubmitWagerTransaction(
          repository,
          new Set(Object.values(config.providerClients)),
          policy,
        ),
    },
  ],
})
export class WageringModule {}
