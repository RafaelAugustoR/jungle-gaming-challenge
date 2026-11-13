import {
  Body,
  Controller,
  Get,
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

@Controller('wallets')
@UseGuards(Identity)
@HumanRole('viewer')
class WalletsController {
  constructor(@Inject(Wallets) private readonly wallets: Wallets) {}
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
}
@Module({
  imports: [IdentityModule],
  controllers: [WalletsController],
  providers: [
    WalletRepository,
    {
      provide: Wallets,
      inject: [WalletRepository],
      useFactory: (repository: WalletRepository) => new Wallets(repository),
    },
  ],
})
export class WalletsModule {}
