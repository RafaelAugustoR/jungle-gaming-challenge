import {
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Module,
  UseGuards,
} from '@nestjs/common';
import { Registry } from 'prom-client';
import { Identity, IdentityModule, HumanRole } from '../modules/identity/identity.module';

@Injectable()
export class MetricsRegistry {
  readonly registry = new Registry();
  scrape() {
    return this.registry.metrics();
  }
}

@Controller('internal')
@UseGuards(Identity)
@HumanRole('viewer')
class MetricsController {
  constructor(@Inject(MetricsRegistry) private readonly metrics: MetricsRegistry) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape() {
    return this.metrics.scrape();
  }
}

@Module({
  imports: [IdentityModule],
  controllers: [MetricsController],
  providers: [MetricsRegistry],
  exports: [MetricsRegistry],
})
export class MetricsModule {}
