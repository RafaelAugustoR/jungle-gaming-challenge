import { cpus, release, totalmem } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/config/config';
import { DATABASE_POOL } from '../../src/config/orm';
import { createSqsClient } from '../../src/config/sqs';
import { provisionEventQueues } from '../../scripts/provision-events';
import { apiProcess } from '../support/api-cluster';
import { disposableDatabase } from '../support/database';
import { humanToken, providerToken } from '../support/keycloak';
import { spawnStaged } from '../support/spawn-staged';
import { runOpenLoop } from './generator';
import {
  buildPlan,
  centsToAmount,
  expectedBalances,
  type FinalState,
  type Plan,
  type Scenario,
} from './plan';
import { parsePrometheus, sumMetric, type Sample } from './prometheus';
import { latency, summarize, type RequestRecord, type RunSummary } from './stats';

export interface LoadOptions {
  scenarios: Scenario[];
  instances: number[];
  rates: number[];
  durationS: number;
  warmupS: number;
  seed: number;
  wallets: number;
  openingCents: bigint;
  oversizedRatio: number;
  duplicateRatio: number;
  duplicateWindow: number;
  maxInFlight: number;
  requestTimeoutMs: number;
  sampleMs: number;
  outboxDrainTimeoutMs: number;
  outDir: string;
}
interface Wallet {
  id: string;
  playerId: string;
}
interface DatabaseSample {
  atMs: number;
  lockWaits: number;
  active: number;
  oldestLockWaitMs: number | null;
  outboxPending: number;
  outboxOldestAgeMs: number | null;
}
const PROVIDER_ID = 'provider-a';
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

export async function collectEnvironment(options: LoadOptions) {
  const config = loadConfig();
  const git = (args: string[]) =>
    Bun.spawnSync(['git', ...args])
      .stdout.toString()
      .trim() || null;
  const compose = await Bun.file('compose.yaml').text();
  const database = await disposableDatabase();
  try {
    const [postgres] = await database.owner.em
      .fork()
      .execute(
        `select version() version, current_setting('max_connections') max_connections, current_setting('shared_buffers') shared_buffers`,
      );
    return {
      at: new Date().toISOString(),
      commit: git(['rev-parse', 'HEAD']),
      dirtyWorkingTree: Boolean(git(['status', '--porcelain'])),
      bun: Bun.version,
      os: { platform: process.platform, release: release(), arch: process.arch },
      cpu: { model: cpus()[0]?.model ?? 'unknown', logicalCores: cpus().length },
      memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      images: [...compose.matchAll(/image:\s*(\S+)/g)].map((m) => m[1]),
      postgres,
      application: {
        poolPerProcess: DATABASE_POOL,
        financialLockTimeoutMs: config.financialLockTimeoutMs,
        financialStatementTimeoutMs: config.financialStatementTimeoutMs,
        financialDeadlineMs: config.financialDeadlineMs,
        outboxPublisher: 'src/bootstrap/outbox-publisher.ts with production defaults',
      },
      generator: {
        model: 'open (constant arrival rate), single Bun process on the same host as the SUT',
        distribution: 'client-side round-robin by operation index; no load balancer',
        options: { ...options, openingCents: centsToAmount(options.openingCents) },
      },
      note: 'Everything (generator, APIs, PostgreSQL, LocalStack, Keycloak) shares one host.',
    };
  } finally {
    await database.close();
  }
}

export async function runScenario(
  scenario: Scenario,
  instances: number,
  rate: number,
  options: LoadOptions,
  log: (line: string) => void = console.log,
) {
  const name = `${scenario}-${instances}x-${rate}rps`;
  const directory = resolve(options.outDir, name);
  await mkdir(directory, { recursive: true });
  const warmupCount = Math.round(options.warmupS * rate);
  const plan = buildPlan({
    scenario,
    seed: options.seed,
    operations: warmupCount + Math.round(options.durationS * rate),
    wallets: options.wallets,
    openingCents: options.openingCents,
    oversizedRatio: options.oversizedRatio,
    duplicateRatio: options.duplicateRatio,
    duplicateWindow: options.duplicateWindow,
  });
  const database = await disposableDatabase();
  const sqs = createSqsClient(database.config);
  const sql = (query: string, params: unknown[] = []) =>
    database.owner.em.fork().execute(query, params);
  const queues: string[] = [];
  const apis: Awaited<ReturnType<typeof apiProcess>>[] = [];
  let publisher: ReturnType<typeof spawnStaged> | undefined;
  let refresh: ReturnType<typeof setInterval> | undefined;
  let cleaned: Promise<void> | undefined;
  // Idempotent so an interrupt handler and the normal finally can both call it.
  const cleanup = () =>
    (cleaned ??= (async () => {
      clearInterval(refresh);
      await publisher?.stop('SIGTERM');
      await Promise.allSettled(apis.map((api) => api.stop()));
      await Promise.allSettled(
        queues.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))),
      );
      sqs.destroy();
      await database.close();
      activeCleanups.delete(cleanup);
    })());
  activeCleanups.add(cleanup);
  try {
    const queueName = `load-events-${crypto.randomUUID().slice(0, 8)}.fifo`;
    const events = await provisionEventQueues(sqs, queueName);
    queues.push(events.queue, events.dlq);
    for (let i = 0; i < instances; i++)
      apis.push(await apiProcess(database.config, `load-api-${i}`));
    const publisherUrl = new URL(database.config.databaseUrl);
    publisherUrl.searchParams.set('application_name', 'load-outbox-publisher');
    publisher = spawnStaged(
      new URL('../../src/bootstrap/outbox-publisher.ts', import.meta.url).pathname,
      {
        DATABASE_URL: publisherUrl.toString(),
        SQS_ENDPOINT: database.config.sqsEndpoint,
        OUTBOX_QUEUE_NAME: queueName,
        METRICS_PORT: '0',
      },
    );
    // Keycloak access tokens default to 5 minutes; refresh both well before expiry.
    let demo = await humanToken('demo-operator');
    let provider = await providerToken('a');
    refresh = setInterval(() => {
      providerToken('a').then(
        (token) => (provider = token),
        () => undefined,
      );
      humanToken('demo-operator').then(
        (token) => (demo = token),
        () => undefined,
      );
    }, 60000);

    const wallets: Wallet[] = [];
    for (let i = 0; i < plan.wallets; i += 10)
      wallets.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(10, plan.wallets - i) }, () =>
            createWallet(apis[0]!.base, demo, centsToAmount(options.openingCents)),
          ),
        )),
      );
    const before = await scrape(apis, demo);

    log(`LOAD_RUN ${name}: ${plan.operations.length} operations (${warmupCount} warmup)`);
    const samples: DatabaseSample[] = [];
    const loadStart = performance.now();
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const sample = await sampleDatabase(sql).catch(() => undefined);
        // A failed sample is a gap, not a run failure; an interrupt may already have closed the DB.
        if (sample) samples.push({ atMs: performance.now() - loadStart, ...sample });
        await Bun.sleep(options.sampleMs);
      }
    })();
    let result: Awaited<ReturnType<typeof runOpenLoop>>;
    try {
      result = await runOpenLoop({
        total: plan.operations.length,
        ratePerSecond: rate,
        warmupCount,
        maxInFlight: options.maxInFlight,
        instances,
        send: async (index, instance) => {
          const op = plan.operations[index]!;
          const wallet = wallets[op.walletIndex]!;
          const response = await fetch(`${apis[instance]!.base}/wagering/transactions`, {
            method: 'POST',
            headers: { ...headers(provider), 'Idempotency-Key': op.idempotencyKey },
            body: JSON.stringify({
              providerId: PROVIDER_ID,
              externalTransactionId: op.externalTransactionId,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: op.roundId,
              gameId: 'load-game',
              kind: op.kind,
              money: { amount: op.amount, currency: 'BRL' },
            }),
            signal: AbortSignal.timeout(options.requestTimeoutMs),
          });
          return { status: response.status, body: await response.json().catch(() => null) };
        },
      });
    } catch (error) {
      sampling = false;
      await sampler;
      throw error;
    }
    const loadEndMs = performance.now() - loadStart;
    // Publication is measured separately: financial responses never wait for the outbox.
    const outbox = () =>
      sql(
        `select count(*) filter (where published_at is null)::int pending,count(*)::int total from wagering.outbox`,
      ).then(([row]) => row as { pending: number; total: number });
    const atLoadEnd = await outbox();
    const drainStart = performance.now();
    let drained = atLoadEnd;
    let outboxDrainMs: number | null = drained.pending === 0 ? 0 : null;
    while (
      outboxDrainMs === null &&
      performance.now() - drainStart < options.outboxDrainTimeoutMs
    ) {
      await Bun.sleep(100);
      drained = await outbox();
      if (drained.pending === 0) outboxDrainMs = Math.round(performance.now() - drainStart);
    }
    const drainSeconds = (performance.now() - drainStart) / 1000;
    const outboxDrain = {
      eventsAtLoadEnd: atLoadEnd.total,
      pendingAtLoadEnd: atLoadEnd.pending,
      drainedAfterMs: outboxDrainMs,
      timeoutMs: options.outboxDrainTimeoutMs,
      pendingWhenStopped: drained.pending,
      publishedPerSecondWhileDraining:
        options.outboxDrainTimeoutMs > 0 && drainSeconds > 0
          ? Math.round(((atLoadEnd.pending - drained.pending) / drainSeconds) * 10) / 10
          : null,
    };
    sampling = false;
    await sampler;
    // Raw results are persisted before any check that could fail.
    await Bun.write(
      resolve(directory, 'requests.ndjson.gz'),
      Bun.gzipSync(
        result.records
          .map((record) => {
            const op = plan.operations[record.index]!;
            return JSON.stringify({
              ...record,
              walletIndex: op.walletIndex,
              kind: op.kind,
              oversized: op.oversized,
              duplicateOf: op.duplicateOf,
            });
          })
          .join('\n') + '\n',
      ),
    );
    await Bun.write(
      resolve(directory, 'db-samples.ndjson.gz'),
      Bun.gzipSync(samples.map((s) => JSON.stringify(s)).join('\n') + '\n'),
    );
    const summary = summarize(result.records, {
      windowStartMs: result.windowStartMs,
      windowEndMs: result.windowEndMs,
      instances,
    });
    let processMetrics: {
      walletLockConflicts: number | null;
      financialRetries: number | null;
      note: string;
    } = {
      walletLockConflicts: null,
      financialRetries: null,
      note: 'Per-process counters scraped from each API via /internal/metrics before/after.',
    };
    let invariants: Invariants;
    try {
      const after = await scrape(apis, demo);
      processMetrics = {
        ...processMetrics,
        walletLockConflicts: delta(before, after, 'wallet_lock_conflicts_total'),
        financialRetries: delta(before, after, 'jungle_retries_total', { component: 'financial' }),
      };
      const finalStates = await resolveFinalStates(plan, result.records, apis[0]!.base, provider);
      invariants = await checkInvariants(plan, finalStates, wallets, apis[0]!.base, demo, sql);
    } catch (error) {
      invariants = failedInvariants(error);
    }
    const run = {
      name,
      scenario,
      instances,
      rate,
      apiPids: apis.map((api) => api.pid),
      wallets: plan.wallets,
      operations: plan.operations.length,
      uniqueOperations: plan.operations.filter((op) => op.duplicateOf === undefined).length,
      summary,
      database: summarizeSamples(samples, result.windowStartMs, result.windowEndMs, loadEndMs),
      outboxDrain,
      processMetrics,
      invariants,
    };
    await Bun.write(resolve(directory, 'run.json'), JSON.stringify(run, null, 2) + '\n');
    log(
      `LOAD_RESULT ${name}: ${formatLine(summary)} invariants=${invariants.ok ? 'ok' : 'FAILED'}`,
    );
    return run;
  } finally {
    await cleanup();
  }
}
export type LoadRun = Awaited<ReturnType<typeof runScenario>>;

const activeCleanups = new Set<() => Promise<void>>();
/** Stops child processes and drops disposable databases/queues of runs still in progress. */
export async function cleanupActiveRuns() {
  await Promise.allSettled([...activeCleanups].map((cleanup) => cleanup()));
}

type Invariants = Awaited<ReturnType<typeof checkInvariants>> & { error?: string };
function failedInvariants(error: unknown): Invariants {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    checks: { harnessCompleted: false } as unknown as Invariants['checks'],
    finalStates: { PROCESSED: 0, REJECTED: 0, NOT_APPLIED: 0 },
    readBackAfterUncertainResponse: 0,
    database: {},
    reconciliation: { wallets: 0, consistent: 0, failures: [] },
  };
}

async function createWallet(base: string, token: string, amount: string): Promise<Wallet> {
  const response = await fetch(`${base}/wallets`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      playerId: crypto.randomUUID(),
      initialBalance: { amount, currency: 'BRL' },
    }),
  });
  if (response.status !== 201) throw new Error(`Wallet creation failed (${response.status})`);
  return (await response.json()) as Wallet;
}

async function scrape(apis: { base: string }[], token: string) {
  return Promise.all(
    apis.map(async (api) => {
      const response = await fetch(`${api.base}/internal/metrics`, { headers: headers(token) });
      if (!response.ok) throw new Error(`Metrics scrape failed (${response.status})`);
      return parsePrometheus(await response.text());
    }),
  );
}
function delta(
  before: Sample[][],
  after: Sample[][],
  name: string,
  filter: Record<string, string> = {},
) {
  return after.reduce(
    (total, samples, i) =>
      total + sumMetric(samples, name, filter) - sumMetric(before[i]!, name, filter),
    0,
  );
}

async function sampleDatabase(sql: (query: string) => Promise<any[]>) {
  const [row] = await sql(`select
      (select count(*)::int from pg_stat_activity where datname=current_database() and wait_event_type='Lock') lock_waits,
      (select count(*)::int from pg_stat_activity where datname=current_database() and state='active' and pid<>pg_backend_pid()) active,
      (select extract(epoch from max(clock_timestamp()-query_start))*1000 from pg_stat_activity where datname=current_database() and wait_event_type='Lock') oldest_lock_wait_ms,
      (select count(*)::int from wagering.outbox where published_at is null) outbox_pending,
      (select extract(epoch from clock_timestamp()-min(occurred_at))*1000 from wagering.outbox where published_at is null) outbox_oldest_age_ms`);
  const number = (value: unknown) => (value === null ? null : Math.round(Number(value)));
  return {
    lockWaits: row.lock_waits as number,
    active: row.active as number,
    oldestLockWaitMs: number(row.oldest_lock_wait_ms),
    outboxPending: row.outbox_pending as number,
    outboxOldestAgeMs: number(row.outbox_oldest_age_ms),
  };
}

function summarizeSamples(
  samples: DatabaseSample[],
  windowStartMs: number,
  windowEndMs: number,
  loadEndMs: number,
) {
  const window = samples.filter((s) => s.atMs >= windowStartMs && s.atMs <= windowEndMs);
  const mean = (values: number[]) =>
    values.length
      ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100
      : null;
  const values = (pick: (s: DatabaseSample) => number | null) =>
    window.map(pick).filter((v): v is number => v !== null);
  return {
    samplesInWindow: window.length,
    lockWaitingBackends: {
      mean: mean(values((s) => s.lockWaits)),
      ...latency(values((s) => s.lockWaits)),
    },
    oldestLockWaitMs: latency(values((s) => s.oldestLockWaitMs)),
    activeBackends: { mean: mean(values((s) => s.active)), ...latency(values((s) => s.active)) },
    outboxPending: latency(values((s) => s.outboxPending)),
    outboxOldestAgeMs: latency(values((s) => s.outboxOldestAgeMs)),
    loadEndMs: Math.round(loadEndMs),
  };
}

/**
 * Final state of every unique operation, taken from any definitive response (original or
 * replay) and otherwise read back by external identity, so uncertain outcomes are resolved.
 */
async function resolveFinalStates(
  plan: Plan,
  records: RequestRecord[],
  base: string,
  token: string,
) {
  const states = new Map<number, FinalState>();
  const firstEffects = new Map<number, number>();
  for (const record of records) {
    const op = plan.operations[record.index]!;
    const original = op.duplicateOf ?? op.index;
    if (record.outcome === 'processed' || record.outcome === 'rejected')
      firstEffects.set(original, (firstEffects.get(original) ?? 0) + 1);
    if (['processed', 'rejected', 'replay'].includes(record.outcome))
      states.set(original, record.httpStatus === 200 ? 'PROCESSED' : 'REJECTED');
  }
  let readBack = 0;
  for (const op of plan.operations) {
    if (op.duplicateOf !== undefined || states.has(op.index)) continue;
    readBack++;
    const response = await fetch(
      `${base}/providers/${PROVIDER_ID}/wagering/transactions/${op.externalTransactionId}`,
      { headers: headers(token) },
    );
    if (response.status === 404) {
      states.set(op.index, 'NOT_APPLIED');
      continue;
    }
    const body = (await response.json()) as { status?: string };
    if (response.status !== 200 || (body.status !== 'PROCESSED' && body.status !== 'REJECTED'))
      throw new Error(`Unresolved final state for ${op.externalTransactionId}: ${body.status}`);
    states.set(op.index, body.status);
  }
  const multipleFirstEffects = [...firstEffects.values()].filter((count) => count > 1).length;
  return Object.assign(states, { readBack, multipleFirstEffects });
}

async function checkInvariants(
  plan: Plan,
  states: Awaited<ReturnType<typeof resolveFinalStates>>,
  wallets: Wallet[],
  base: string,
  token: string,
  sql: (query: string) => Promise<any[]>,
) {
  const expected = expectedBalances(plan, states).map(centsToAmount);
  const reconciliation = await Promise.all(
    wallets.map(async (wallet, i) => {
      const response = await fetch(`${base}/wallets/${wallet.id}/reconciliation`, {
        method: 'POST',
        headers: headers(token),
      });
      const body = (await response.json()) as {
        consistent?: boolean;
        storedBalance?: { amount: string };
        calculatedBalance?: { amount: string };
      };
      return {
        ok:
          response.status === 200 &&
          body.consistent === true &&
          body.storedBalance?.amount === expected[i] &&
          body.calculatedBalance?.amount === expected[i],
        expected: expected[i],
        stored: body.storedBalance?.amount,
        calculated: body.calculatedBalance?.amount,
      };
    }),
  );
  const counts = { PROCESSED: 0, REJECTED: 0, NOT_APPLIED: 0 };
  for (const state of states.values()) counts[state]++;
  const oversizedProcessed = [...states].filter(
    ([index, state]) => state === 'PROCESSED' && plan.operations[index]!.oversized,
  ).length;
  const [database] = await sql(`select
      (select count(*)::int from wagering.transactions where kind<>'OPENING') transactions,
      (select count(*)::int from wagering.transactions where kind<>'OPENING' and status='PROCESSED') processed,
      (select count(*)::int from wagering.transactions where kind<>'OPENING' and status='REJECTED') rejected,
      (select count(*)::int from wagering.transactions where status not in ('PROCESSED','REJECTED')) non_terminal,
      (select count(*)::int from wagering.journal) journal_entries,
      (select count(*)::int from wagering.journal j join wagering.accounts d on d.id=j.debit_account_id join wagering.accounts c on c.id=j.credit_account_id where j.amount<=0 or d.id=c.id or d.currency<>j.currency or c.currency<>j.currency) invalid_pairs,
      (select count(*)::int from wagering.transactions t where t.kind<>'OPENING' and ((select count(*) from wagering.outbox o where o.transaction_id=t.id and o.event_type=case t.status when 'PROCESSED' then 'WagerTransactionProcessed' else 'WagerTransactionRejected' end)<>1 or (select count(*) from wagering.outbox o where o.transaction_id=t.id and o.event_type='WalletBalanceChanged')<>case when t.status='PROCESSED' then 1 else 0 end)) invalid_event_sets`);
  const openingEntries = plan.options.openingCents > 0n ? wallets.length : 0;
  const checks = {
    reconciledWallets: reconciliation.every((r) => r.ok),
    transactionsMatchUniqueOperations: database.transactions === counts.PROCESSED + counts.REJECTED,
    processedMatches: database.processed === counts.PROCESSED,
    rejectedMatches: database.rejected === counts.REJECTED,
    noNonTerminalTransactions: database.non_terminal === 0,
    journalEntriesMatch: database.journal_entries === openingEntries + counts.PROCESSED,
    balancedPairs: database.invalid_pairs === 0,
    oneEventSetPerTransaction: database.invalid_event_sets === 0,
    noDuplicateFinancialEffect: states.multipleFirstEffects === 0,
    oversizedNeverProcessed: oversizedProcessed === 0,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    finalStates: counts,
    readBackAfterUncertainResponse: states.readBack,
    database,
    reconciliation: {
      wallets: reconciliation.length,
      consistent: reconciliation.filter((r) => r.ok).length,
      failures: reconciliation.filter((r) => !r.ok).slice(0, 10),
    },
  };
}

export function formatLine(summary: RunSummary) {
  const o = summary.outcomes;
  return [
    `offered=${summary.offeredRps.toFixed(1)}/s`,
    `completed=${summary.completedRps.toFixed(1)}/s`,
    `p50=${summary.latencyMs.p50}ms p95=${summary.latencyMs.p95}ms p99=${summary.latencyMs.p99}ms`,
    `processed=${o.processed} rejected=${o.rejected} replay=${o.replay}`,
    `errors=${o.error} conflicts=${o.conflict} notIssued=${o.not_issued}`,
  ].join(' ');
}
