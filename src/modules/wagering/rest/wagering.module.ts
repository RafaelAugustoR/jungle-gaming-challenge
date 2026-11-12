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
import {
  Identity,
  IdentityModule,
  WagerAccess,
  type Principal,
} from '../../identity/identity.module';
import { apiError } from '../../../shared/rest/api-error';
import { parseWalletId } from '../../wallets/rest/wallet-contract';
import { SubmitBet } from '../application/submit-bet';
import { WageringRepository } from '../infrastructure/persistence/wagering-repository';
import { identifier, parseBet } from './wager-contract';
import type { TransactionView } from '../application/wagering-store';

interface RequestContext {
  principal: Principal;
  correlationId: string;
  headers: Record<string, string | undefined>;
}
function owned(view: TransactionView | undefined, principal: Principal) {
  if (!view || (principal.kind === 'provider' && view.providerId !== principal.providerId))
    throw apiError(404, 'TRANSACTION_NOT_FOUND');
  return view;
}
@Controller()
@UseGuards(Identity)
class WageringController {
  constructor(
    @Inject(SubmitBet) private readonly submitBet: SubmitBet,
    @Inject(WageringRepository) private readonly repository: WageringRepository,
  ) {}
  @Post('wagering/transactions')
  @WagerAccess('submit')
  async submit(
    @Body() body: unknown,
    @Req() request: RequestContext,
    @Res({ passthrough: true }) response: { status(value: number): void },
  ) {
    const command = parseBet(body);
    const key = identifier(request.headers['idempotency-key']);
    if (
      request.principal.kind !== 'provider' ||
      request.principal.providerId !== command.providerId
    )
      throw apiError(403, 'PROVIDER_IDENTITY_MISMATCH');
    const receipt = await this.submitBet.execute(command, key, {
      correlationId: request.correlationId,
    });
    response.status(receipt.httpStatus);
    return receipt.body;
  }
  @Get('wagering/transactions/:transactionId')
  @WagerAccess('read')
  async get(@Param('transactionId') id: string, @Req() request: RequestContext) {
    return owned(await this.repository.find(parseWalletId(id)), request.principal);
  }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @WagerAccess('read')
  async getExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
    @Req() request: RequestContext,
  ) {
    identifier(providerId);
    identifier(externalId);
    if (request.principal.kind === 'provider' && request.principal.providerId !== providerId)
      throw apiError(404, 'TRANSACTION_NOT_FOUND');
    return owned(await this.repository.findExternal(providerId, externalId), request.principal);
  }
}
@Module({
  imports: [IdentityModule],
  controllers: [WageringController],
  providers: [
    WageringRepository,
    {
      provide: SubmitBet,
      inject: [WageringRepository, APP_CONFIG],
      useFactory: (repository: WageringRepository, config: AppConfig) =>
        new SubmitBet(repository, new Set(Object.values(config.providerClients))),
    },
  ],
})
export class WageringModule {}
