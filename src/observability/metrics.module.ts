import {
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
  UseGuards,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { Identity, IdentityModule, HumanRole } from '../modules/identity/identity.module';
import { APP_CONFIG } from '../config/infrastructure.module';
import type { AppConfig } from '../config/config';
import { isMetricsPeerAllowed } from './metrics-network';

@Injectable()
export class MetricsRegistry {
  readonly registry = new Registry();
  readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  readonly httpDuration: Histogram<'method' | 'route'>;
  readonly transactionDuplicates: Counter<'operation' | 'channel'>;
  readonly transactionAttempts: Counter<'operation' | 'channel' | 'status'>;
  readonly transactionDuration: Histogram<'operation' | 'channel' | 'status'>;
  readonly workerRetries: Counter<'worker'>;
  readonly workerDeadLetters: Counter<'worker'>;
  readonly walletLockConflicts: Counter<'source'>;
  readonly wageringTransactionRetries: Counter<'reason'>;
  readonly outboxRetryAttempts: Counter<'disposition'>;
  readonly outboxPending: Gauge;
  readonly outboxBlocked: Gauge;
  readonly outboxOldestAge: Gauge;
  readonly referenceRetryAttempts: Gauge;
  readonly durableTransactions: Gauge<'operation' | 'status'>;
  private durableCacheUntil = 0;
  private durableRefresh?: Promise<void>;

  constructor(private readonly orm: MikroORM) {
    collectDefaultMetrics({ register: this.registry });
    this.httpRequests = new Counter({
      name: 'jungle_http_requests_total', help: 'Completed HTTP requests.',
      labelNames: ['method', 'route', 'status'], registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: 'jungle_http_request_duration_seconds', help: 'HTTP request duration in seconds.',
      labelNames: ['method', 'route'], registers: [this.registry],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    });
    this.transactionDuplicates = new Counter({
      name: 'wager_transaction_duplicates_total', help: 'Idempotent transaction replays observed by this process.',
      labelNames: ['operation', 'channel'], registers: [this.registry],
    });
    this.transactionAttempts = new Counter({
      name: 'wager_transaction_attempts_total', help: 'Submission outcomes observed by this process; resets on restart.',
      labelNames: ['operation', 'channel', 'status'], registers: [this.registry],
    });
    this.transactionDuration = new Histogram({
      name: 'wager_transaction_duration_seconds', help: 'Time spent processing submission requests.',
      labelNames: ['operation', 'channel', 'status'], registers: [this.registry],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    });
    this.workerRetries = new Counter({
      name: 'worker_retries_total', help: 'Retry scheduling decisions observed by this process.',
      labelNames: ['worker'], registers: [this.registry],
    });
    this.workerDeadLetters = new Counter({
      name: 'worker_dead_letters_total', help: 'Messages successfully transferred to a dead-letter queue.',
      labelNames: ['worker'], registers: [this.registry],
    });
    this.walletLockConflicts = new Counter({
      name: 'wallet_lock_conflicts_total', help: 'Financial lock timeout conflicts observed by this process.',
      labelNames: ['source'], registers: [this.registry],
    });
    this.wageringTransactionRetries = new Counter({
      name: 'wagering_transaction_retries_total', help: 'Internal financial transaction retries attempted before returning a result.',
      labelNames: ['reason'], registers: [this.registry],
    });
    this.outboxRetryAttempts = new Counter({
      name: 'outbox_retry_attempts_total', help: 'Outbox publication retry decisions observed by this process.',
      labelNames: ['disposition'], registers: [this.registry],
    });
    this.outboxPending = new Gauge({
      name: 'outbox_pending_events', help: 'Current unpublished outbox event count, including blocked rows.', registers: [this.registry],
    });
    this.outboxBlocked = new Gauge({
      name: 'outbox_blocked_events', help: 'Current unpublished outbox events blocked by a permanent publication error.', registers: [this.registry],
    });
    this.outboxOldestAge = new Gauge({
      name: 'outbox_oldest_pending_age_seconds', help: 'Age of the oldest unpublished outbox event, including blocked events.', registers: [this.registry],
    });
    this.referenceRetryAttempts = new Gauge({
      name: 'reference_retry_attempts', help: 'Persisted retry attempts across currently scheduled reference transactions.',
      registers: [this.registry],
    });
    this.durableTransactions = new Gauge({
      name: 'wager_transactions', help: 'Persisted transaction rows grouped by operation and current status.',
      labelNames: ['operation', 'status'], registers: [this.registry],
    });
  }

  async scrape(includeDurable = true) {
    if (includeDurable) {
      if (Date.now() >= this.durableCacheUntil) {
        if (!this.durableRefresh) {
          this.durableRefresh = this.refreshDurableSnapshot().then(() => {
            this.durableCacheUntil = Date.now() + 2000;
          }).finally(() => { this.durableRefresh = undefined; });
        }
        await this.durableRefresh;
      }
    }
    return this.registry.metrics();
  }

  private async refreshDurableSnapshot() {
    const rows = await this.orm.em.fork().transactional(async (em) => {
      await em.execute("set local statement_timeout = '750ms'");
      return em.execute<{
        metric: 'transaction' | 'outbox' | 'references';
        operation: string | null;
        status: string | null;
        value: string;
        age: string | null;
        blocked: string | null;
      }[]>(`with transaction_counts as (
          select kind as operation,status,count(*)::text as value
          from wagering.transactions group by kind,status
        ), outbox_counts as (
          select count(*)::text as value,
            coalesce(extract(epoch from clock_timestamp()-min(occurred_at)),0)::text as age,
            count(*) filter (where blocked_at is not null)::text as blocked
          from wagering.outbox where published_at is null
        ), reference_counts as (
          select coalesce(sum(attempts),0)::text as value
          from wagering.reference_retries where completed_at is null
        )
        select 'transaction'::text as metric,operation,status,value,null::text as age,null::text as blocked from transaction_counts
        union all
        select 'outbox',null,null,value,age,blocked from outbox_counts
        union all
        select 'references',null,null,value,null,null from reference_counts`);
    });
    this.durableTransactions.reset();
    for (const row of rows) {
      if (row.metric === 'transaction' && row.operation && row.status)
        this.durableTransactions.set({ operation: row.operation, status: row.status }, Number(row.value));
      if (row.metric === 'outbox') {
        this.outboxPending.set(Number(row.value));
        this.outboxBlocked.set(Number(row.blocked ?? 0));
        this.outboxOldestAge.set(Number(row.age ?? 0));
      }
      if (row.metric === 'references') this.referenceRetryAttempts.set(Number(row.value));
    }
  }
}

export function startMetricsListener(metrics: MetricsRegistry, port: number, includeDurable = false, allowedCidr = '') {
  if (port === 0) return undefined;
  return Bun.serve({
    port,
    hostname: '0.0.0.0',
    fetch: async (request, server) => {
      if (request.method !== 'GET' || new URL(request.url).pathname !== '/metrics')
        return new Response('Not found', { status: 404 });
      if (!isMetricsPeerAllowed(server.requestIP(request)?.address, allowedCidr))
        return new Response('Forbidden', { status: 403 });
      try {
        return new Response(await metrics.scrape(includeDurable), {
          headers: { 'Content-Type': metrics.registry.contentType },
        });
      } catch {
        return new Response('Metrics temporarily unavailable', { status: 503 });
      }
    },
  });
}

@Injectable()
class MetricsListenerLifecycle implements OnModuleInit, OnApplicationShutdown {
  private server?: ReturnType<typeof startMetricsListener>;
  constructor(
    @Inject(MetricsRegistry) private readonly metrics: MetricsRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  onModuleInit() {
    this.server = startMetricsListener(
      this.metrics,
      this.config.metricsPort,
      this.config.metricsIncludeDurable,
      this.config.metricsAllowedCidr,
    );
  }
  onApplicationShutdown() { this.server?.stop(true); }
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
  providers: [
    { provide: MetricsRegistry, inject: [MikroORM], useFactory: (orm: MikroORM) => new MetricsRegistry(orm) },
    MetricsListenerLifecycle,
  ],
  exports: [MetricsRegistry],
})
export class MetricsModule {}
