import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  Identity,
  IdentityModule,
  HumanRole,
  type Principal,
} from '../../identity/identity.module';
import { WalletRepository } from '../infrastructure/persistence/wallet-repository';
import {
  parseCreateWallet,
  parseLedgerQuery,
  walletResponse,
  ledgerResponse,
} from './wallet-contract';
import { parseUuid } from '../../../shared/rest/parse-uuid';
import { Wallets } from '../application/wallets';
import { MetricsModule } from '../../../observability/metrics.module';
import { PrometheusWalletReconciliationObserver } from '../infrastructure/observability/prometheus-wallet-reconciliation-observer';

@Controller('wallets')
@UseGuards(Identity)
@HumanRole('viewer')
class WalletsController {
  constructor(
    @Inject(Wallets) private readonly wallets: Wallets,
  ) {}
  @Post()
  @HumanRole('demo-operator')
  async create(
    @Body() body: unknown,
    @Req() request: { principal: Principal; correlationId: string },
  ) {
    return walletResponse(
      await this.wallets.create(parseCreateWallet(body), {
        actorId: request.principal.subject,
        correlationId: request.correlationId,
      }),
    );
  }
  @Get(':walletId')
  async get(@Param('walletId') id: string) {
    return walletResponse(await this.wallets.get(parseUuid(id)));
  }
  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    parseUuid(id);
    return ledgerResponse(id, await this.wallets.ledger(id, parseLedgerQuery(id, cursor, limit)));
  }
  @Post(':walletId/reconciliation')
  @HumanRole('operator')
  @HttpCode(200)
  async reconcile(
    @Param('walletId') id: string,
    @Req() request: { principal: Principal; correlationId: string },
  ) {
    parseUuid(id);
    return this.wallets.reconcile(id, {
      actorId: request.principal.subject,
      correlationId: request.correlationId,
    });
  }
}

@Module({
  imports: [IdentityModule, MetricsModule],
  controllers: [WalletsController],
  providers: [
    WalletRepository,
    PrometheusWalletReconciliationObserver,
    {
      provide: Wallets,
      inject: [WalletRepository, PrometheusWalletReconciliationObserver],
      useFactory: (
        repository: WalletRepository,
        observer: PrometheusWalletReconciliationObserver,
      ) => new Wallets(repository, observer),
    },
  ],
  exports: [Wallets],
})
export class WalletsModule {}
