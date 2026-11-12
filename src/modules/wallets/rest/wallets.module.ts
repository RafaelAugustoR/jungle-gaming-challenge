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
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  Identity,
  IdentityModule,
  HumanRole,
  type Principal,
} from '../../identity/identity.module';
import { ApiErrorFilter } from '../../../shared/rest/api-error';
import { Wallets } from '../application/wallets';

@Controller('wallets')
@UseGuards(Identity)
@UseFilters(ApiErrorFilter)
@HumanRole('viewer')
class WalletsController {
  constructor(@Inject(Wallets) private readonly wallets: Wallets) {}
  @Post()
  @HumanRole('demo-operator')
  create(@Body() body: unknown, @Req() request: { principal: Principal; correlationId: string }) {
    return this.wallets.create(body, {
      actorId: request.principal.subject,
      correlationId: request.correlationId,
    });
  }
  @Get(':walletId')
  get(@Param('walletId') id: string) {
    return this.wallets.get(id);
  }
  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.wallets.ledger(id, cursor, limit);
  }
}
@Module({ imports: [IdentityModule], controllers: [WalletsController], providers: [Wallets] })
export class WalletsModule {}
