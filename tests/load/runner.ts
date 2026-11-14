import { cpus, release, totalmem } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, loadMigrationConfig } from '../../src/config/config';
import { DATABASE_POOL, openDatabase } from '../../src/config/orm';
import { runOpenLoop } from './generator';
import { buildPlan, centsToAmount, SCENARIOS, type Scenario } from './plan';
import { drainOutbox, processMetricDeltas, startSampler, summarizeSamples } from './probes';
import { summarize, type RequestRecord, type RunSummary } from './stats';
import { loadTopology } from './topology';
import { checkInvariants, harnessFailure, resolveFinalStates, type Verification } from './verify';

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

/** Single source of defaults for the CLI, the smoke test and the documentation table. */
export const DEFAULT_LOAD_OPTIONS: Readonly<Omit<LoadOptions, 'outDir'>> = Object.freeze({
  scenarios: [...SCENARIOS],
  instances: [1, 3],
  rates: [100, 500],
  durationS: 30,
  warmupS: 5,
  seed: 20261113,
  wallets: 100,
  openingCents: 1_000_000_00n,
  oversizedRatio: 0.02,
  duplicateRatio: 0.3,
  duplicateWindow: 20,
  maxInFlight: 256,
  requestTimeoutMs: 20000,
  sampleMs: 200,
  outboxDrainTimeoutMs: 30000,
});

export async function collectEnvironment(options: LoadOptions) {
  const config = loadConfig();
  const git = (args: string[]) =>
    Bun.spawnSync(['git', ...args])
      .stdout.toString()
      .trim() || null;
  const compose = await Bun.file('compose.yaml').text();
  // Server settings only: the admin connection is enough, no disposable database needed.
  const admin = await openDatabase(loadMigrationConfig());
  try {
    const [postgres] = await admin.em
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
    await admin.close(true);
  }
}

async function writeRaw(
  directory: string,
  records: RequestRecord[],
  plan: ReturnType<typeof buildPlan>,
  samples: unknown[],
) {
  const ndjson = (lines: unknown[]) =>
    Bun.gzipSync(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  await Bun.write(
    resolve(directory, 'requests.ndjson.gz'),
    ndjson(
      records.map((record) => {
        const op = plan.operations[record.index]!;
        return {
          ...record,
          walletIndex: op.walletIndex,
          kind: op.kind,
          oversized: op.oversized,
          duplicateOf: op.duplicateOf,
        };
      }),
    ),
  );
  await Bun.write(resolve(directory, 'db-samples.ndjson.gz'), ndjson(samples));
}

/** Orchestrates one run: topology → load with probes → raw results → verification. */
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
  const topology = await loadTopology(instances, options, log);
  try {
    const wallets = await topology.createWallets(plan.wallets, centsToAmount(options.openingCents));
    const before = await topology.scrapeMetrics();

    log(`LOAD_RUN ${name}: ${plan.operations.length} operations (${warmupCount} warmup)`);
    const sampler = startSampler(topology.sql, options.sampleMs);
    const loadStart = performance.now();
    let result: Awaited<ReturnType<typeof runOpenLoop>>;
    try {
      result = await runOpenLoop({
        total: plan.operations.length,
        ratePerSecond: rate,
        warmupCount,
        maxInFlight: options.maxInFlight,
        instances,
        send: (index, instance) => {
          const op = plan.operations[index]!;
          return topology.submit(instance, op, wallets[op.walletIndex]!);
        },
      });
    } catch (error) {
      await sampler.stop();
      throw error;
    }
    // Includes waiting for in-flight responses after the last scheduled operation.
    const loadEndMs = performance.now() - loadStart;
    const outboxDrain = await drainOutbox(topology.sql, options.outboxDrainTimeoutMs);
    const samples = await sampler.stop();
    // Raw results are persisted before any check that could fail.
    await writeRaw(directory, result.records, plan, samples);
    const summary = summarize(result.records, {
      windowStartMs: result.windowStartMs,
      windowEndMs: result.windowEndMs,
      instances,
    });

    let processMetrics: ReturnType<typeof processMetricDeltas> | null = null;
    let verification: Verification;
    try {
      processMetrics = processMetricDeltas(before, await topology.scrapeMetrics());
      const resolution = await resolveFinalStates(plan, result.records, topology.readBack);
      verification = await checkInvariants(plan, result.records, resolution, {
        wallets,
        sql: topology.sql,
        reconcile: topology.reconcile,
      });
    } catch (error) {
      verification = harnessFailure(error);
    }
    const run = {
      name,
      scenario,
      instances,
      rate,
      apiPids: topology.apiPids,
      wallets: plan.wallets,
      operations: plan.operations.length,
      uniqueOperations: plan.operations.filter((op) => op.duplicateOf === undefined).length,
      summary,
      database: summarizeSamples(samples, result.windowStartMs, result.windowEndMs, loadEndMs),
      outboxDrain,
      processMetrics,
      verification,
    };
    await Bun.write(resolve(directory, 'run.json'), JSON.stringify(run, null, 2) + '\n');
    log(
      `LOAD_RESULT ${name}: ${formatLine(summary)} invariants=${verification.ok ? 'ok' : 'FAILED'}`,
    );
    return run;
  } finally {
    await topology.close();
  }
}
export type LoadRun = Awaited<ReturnType<typeof runScenario>>;

export function formatLine(summary: RunSummary) {
  const o = summary.outcomes;
  return [
    `offered=${summary.offeredRps.toFixed(1)}/s`,
    `completed=${summary.completedRps.toFixed(1)}/s`,
    `p50=${summary.latencyMs.p50}ms p95=${summary.latencyMs.p95}ms p99=${summary.latencyMs.p99}ms`,
    `processed=${o.processed} rejected=${o.rejected} replay=${o.replay}`,
    `errors=${summary.errors} notIssued=${o.not_issued}`,
  ].join(' ');
}
