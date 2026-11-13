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
import { isMetricsPeerAllowed, type ParsedMetricsCidr } from './metrics-network';
import type { SubmissionObserver } from '../modules/wagering/application/submit-wager-transaction';
import type { CommandConsumerObserver } from '../messaging/commands/command-consumer';
import type { PublisherObserver } from '../messaging/outbox/outbox-publisher';
import type { WageringRepositoryObserver } from '../modules/wagering/infrastructure/persistence/wagering-repository';
import type { EventConsumerObserver } from '../messaging/events/event-consumer';

@Injectable()
export class MetricsRegistry {
  readonly registry = new Registry();
  readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  readonly httpDuration: Histogram<'method' | 'route'>;
  readonly transactionDuplicates: Counter<'operation' | 'channel'>;
  readonly transactionAttempts: Counter<'operation' | 'channel' | 'status'>;
  readonly transactionDuration: Histogram<'operation' | 'channel' | 'status'>;
  readonly retries: Counter<'component' | 'reason'>;
  readonly workerDeadLetters: Counter<'worker'>;
  readonly dlqMessages: Gauge<'worker'>;
  readonly walletLockConflicts: Counter<'source'>;
  readonly durableSnapshotSuccess: Gauge;
  readonly durableSnapshotAge: Gauge;
  readonly outboxPending: Gauge;
  readonly outboxBlocked: Gauge;
  readonly outboxOldestAge: Gauge;
  readonly referencePending: Gauge;
  readonly referenceOldestAge: Gauge;
  readonly durableTransactions: Gauge<'operation' | 'status'>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    this.httpRequests = new Counter({
      name: 'jungle_http_requests_total',
      help: 'Completed HTTP requests.',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: 'jungle_http_request_duration_seconds',
      help: 'HTTP request duration in seconds.',
      labelNames: ['method', 'route'],
      registers: [this.registry],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    });
    this.transactionDuplicates = new Counter({
      name: 'wager_transaction_duplicates_total',
      help: 'Idempotent transaction replays observed by this process.',
      labelNames: ['operation', 'channel'],
      registers: [this.registry],
    });
    this.transactionAttempts = new Counter({
      name: 'wager_transaction_attempts_total',
      help: 'Submission outcomes observed by this process; resets on restart.',
      labelNames: ['operation', 'channel', 'status'],
      registers: [this.registry],
    });
    this.transactionDuration = new Histogram({
      name: 'wager_transaction_duration_seconds',
      help: 'Time spent processing submission requests.',
      labelNames: ['operation', 'channel', 'status'],
      registers: [this.registry],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    });
    this.retries = new Counter({
      name: 'jungle_retries_total',
      help: 'Retry decisions grouped by bounded component and reason.',
      labelNames: ['component', 'reason'],
      registers: [this.registry],
    });
    this.workerDeadLetters = new Counter({
      name: 'worker_dead_letters_total',
      help: 'Messages successfully transferred to a dead-letter queue.',
      labelNames: ['worker'],
      registers: [this.registry],
    });
    this.dlqMessages = new Gauge({
      name: 'worker_dlq_messages',
      help: 'Approximate visible, delayed and in-flight messages in configured worker DLQs.',
      labelNames: ['worker'],
      registers: [this.registry],
    });
    this.walletLockConflicts = new Counter({
      name: 'wallet_lock_conflicts_total',
      help: 'Financial lock timeout conflicts observed by this process.',
      labelNames: ['source'],
      registers: [this.registry],
    });
    this.durableSnapshotSuccess = new Gauge({
      name: 'durable_snapshot_success',
      help: 'Whether the latest durable database snapshot refresh succeeded.',
      registers: [this.registry],
    });
    this.durableSnapshotSuccess.set(0);
    this.durableSnapshotAge = new Gauge({
      name: 'durable_snapshot_age_seconds',
      help: 'Age of the last successful durable database snapshot.',
      registers: [this.registry],
    });
    this.durableSnapshotAge.set(0);
    this.outboxPending = new Gauge({
      name: 'outbox_pending_events',
      help: 'Current unpublished outbox event count, including blocked rows.',
      registers: [this.registry],
    });
    this.outboxBlocked = new Gauge({
      name: 'outbox_blocked_events',
      help: 'Current unpublished outbox events blocked by a permanent publication error.',
      registers: [this.registry],
    });
    this.outboxOldestAge = new Gauge({
      name: 'outbox_oldest_pending_age_seconds',
      help: 'Age of the oldest unpublished outbox event, including blocked events.',
      registers: [this.registry],
    });
    this.referencePending = new Gauge({
      name: 'reference_pending_transactions',
      help: 'Number of persisted reference transactions still pending.',
      registers: [this.registry],
    });
    this.referenceOldestAge = new Gauge({
      name: 'reference_oldest_pending_age_seconds',
      help: 'Age of the oldest pending reference transaction.',
      registers: [this.registry],
    });
    this.durableTransactions = new Gauge({
      name: 'wager_transactions',
      help: 'Persisted transaction rows grouped by operation and current status.',
      labelNames: ['operation', 'status'],
      registers: [this.registry],
    });
  }

  scrape() {
    return this.registry.metrics();
  }
}

export function submissionMetricsObserver(metrics: MetricsRegistry): SubmissionObserver {
  return {
    completed: ({ operation, channel, status, durationSeconds, idempotentReplay }) => {
      metrics.transactionAttempts.inc({ operation, channel, status });
      metrics.transactionDuration.observe({ operation, channel, status }, durationSeconds);
      if (idempotentReplay) metrics.transactionDuplicates.inc({ operation, channel });
      if (channel === 'reference' && status === 'PENDING_REFERENCE')
        metrics.retries.inc({ component: 'reference', reason: 'reference_pending' });
    },
    failed: ({ operation, channel, durationSeconds }) => {
      metrics.transactionAttempts.inc({ operation, channel, status: 'error' });
      metrics.transactionDuration.observe({ operation, channel, status: 'error' }, durationSeconds);
    },
  };
}

export function commandConsumerMetricsObserver(metrics: MetricsRegistry): CommandConsumerObserver {
  return {
    deadLetterSent: async () => metrics.workerDeadLetters.inc({ worker: 'command' }),
    retryScheduled: () => metrics.retries.inc({ component: 'command', reason: 'message_retry' }),
    dlqDepth: (depth) => metrics.dlqMessages.set({ worker: 'command' }, depth),
  };
}

export function publisherMetricsObserver(metrics: MetricsRegistry): PublisherObserver {
  return {
    retryScheduled: (disposition) =>
      metrics.retries.inc({ component: 'outbox', reason: disposition }),
  };
}

export function wageringRepositoryMetricsObserver(
  metrics: MetricsRegistry,
): WageringRepositoryObserver {
  return {
    lockConflict: () => metrics.walletLockConflicts.inc({ source: 'financial' }),
    retry: (reason) => metrics.retries.inc({ component: 'financial', reason }),
  };
}

export function eventConsumerMetricsObserver(metrics: MetricsRegistry): EventConsumerObserver {
  return { dlqDepth: (depth) => metrics.dlqMessages.set({ worker: 'event-consumer' }, depth) };
}

@Injectable()
export class DurableMetricsCollector {
  private cacheUntil = 0;
  private refreshInFlight?: Promise<void>;
  private lastSuccessAt?: number;
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: MetricsRegistry,
  ) {}
  async refresh() {
    if (Date.now() >= this.cacheUntil) {
      if (!this.refreshInFlight) {
        this.refreshInFlight = this.refreshSnapshot()
          .then(() => {
            this.lastSuccessAt = Date.now();
            this.cacheUntil = this.lastSuccessAt + 2000;
            this.metrics.durableSnapshotSuccess.set(1);
          })
          .catch(() => this.metrics.durableSnapshotSuccess.set(0))
          .finally(() => {
            this.refreshInFlight = undefined;
          });
      }
      await this.refreshInFlight;
    }
    this.metrics.durableSnapshotAge.set(
      this.lastSuccessAt === undefined ? 0 : (Date.now() - this.lastSuccessAt) / 1000,
    );
  }
  private async refreshSnapshot() {
    const rows = await this.orm.em.fork().transactional(async (em) => {
      await em.execute("set local statement_timeout = '750ms'");
      return em.execute<
        {
          metric: 'transaction' | 'outbox' | 'references';
          operation: string | null;
          status: string | null;
          value: string;
          age: string | null;
          blocked: string | null;
        }[]
      >(`with transaction_counts as (
          select kind as operation,status,count(*)::text as value
          from wagering.transactions group by kind,status
        ), outbox_counts as (
          select count(*)::text as value,
            coalesce(extract(epoch from clock_timestamp()-min(occurred_at)),0)::text as age,
            count(*) filter (where blocked_at is not null)::text as blocked
          from wagering.outbox where published_at is null
        ), reference_counts as (
          select count(*)::text as value,
            coalesce(extract(epoch from clock_timestamp()-min(t.created_at)),0)::text as age
          from wagering.reference_retries r join wagering.transactions t on t.id=r.transaction_id
          where r.completed_at is null
        )
        select 'transaction'::text as metric,operation,status,value,null::text as age,null::text as blocked from transaction_counts
        union all
        select 'outbox',null,null,value,age,blocked from outbox_counts
        union all
        select 'references',null,null,value,age,null from reference_counts`);
    });
    this.metrics.durableTransactions.reset();
    for (const row of rows) {
      if (row.metric === 'transaction' && row.operation && row.status)
        this.metrics.durableTransactions.set(
          { operation: row.operation, status: row.status },
          Number(row.value),
        );
      if (row.metric === 'outbox') {
        this.metrics.outboxPending.set(Number(row.value));
        this.metrics.outboxBlocked.set(Number(row.blocked ?? 0));
        this.metrics.outboxOldestAge.set(Number(row.age ?? 0));
      }
      if (row.metric === 'references') {
        this.metrics.referencePending.set(Number(row.value));
        this.metrics.referenceOldestAge.set(Number(row.age ?? 0));
      }
    }
  }
}

export function startMetricsListener(
  metrics: MetricsRegistry,
  port: number,
  allowedCidr?: ParsedMetricsCidr,
  durable?: DurableMetricsCollector,
) {
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
        await durable?.refresh();
        return new Response(await metrics.scrape(), {
          headers: { 'Content-Type': metrics.registry.contentType },
        });
      } catch {
        return new Response(await metrics.scrape(), {
          headers: { 'Content-Type': metrics.registry.contentType },
        });
      }
    },
  });
}

@Injectable()
class MetricsListenerLifecycle implements OnModuleInit, OnApplicationShutdown {
  private server?: ReturnType<typeof startMetricsListener>;
  constructor(
    @Inject(MetricsRegistry) private readonly metrics: MetricsRegistry,
    @Inject(DurableMetricsCollector) private readonly durable: DurableMetricsCollector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  onModuleInit() {
    this.server = startMetricsListener(
      this.metrics,
      this.config.metricsPort,
      this.config.metricsAllowedNetwork,
      this.durable,
    );
  }
  onApplicationShutdown() {
    this.server?.stop(true);
  }
}

@Controller('internal')
@UseGuards(Identity)
@HumanRole('viewer')
class MetricsController {
  constructor(
    @Inject(MetricsRegistry) private readonly metrics: MetricsRegistry,
    @Inject(DurableMetricsCollector) private readonly durable: DurableMetricsCollector,
  ) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape() {
    await this.durable.refresh();
    return this.metrics.scrape();
  }
}

@Module({
  imports: [IdentityModule],
  controllers: [MetricsController],
  providers: [MetricsRegistry, DurableMetricsCollector, MetricsListenerLifecycle],
  exports: [MetricsRegistry],
})
export class MetricsModule {}
