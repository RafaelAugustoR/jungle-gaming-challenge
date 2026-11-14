import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SCENARIOS, type Scenario } from '../tests/load/plan';
import { renderReport } from '../tests/load/report';
import {
  cleanupActiveRuns,
  collectEnvironment,
  runScenario,
  type LoadOptions,
  type LoadRun,
} from '../tests/load/runner';

const { values } = parseArgs({
  options: {
    scenarios: { type: 'string', default: SCENARIOS.join(',') },
    instances: { type: 'string', default: '1,3' },
    rate: { type: 'string', default: '100,500' },
    duration: { type: 'string', default: '30' },
    warmup: { type: 'string', default: '5' },
    seed: { type: 'string', default: '20261113' },
    wallets: { type: 'string', default: '100' },
    opening: { type: 'string', default: '1000000' },
    'oversized-ratio': { type: 'string', default: '0.02' },
    'duplicate-ratio': { type: 'string', default: '0.3' },
    'duplicate-window': { type: 'string', default: '20' },
    'max-in-flight': { type: 'string', default: '256' },
    'request-timeout': { type: 'string', default: '20000' },
    'sample-ms': { type: 'string', default: '200' },
    'outbox-drain-timeout': { type: 'string', default: '30000' },
    out: { type: 'string' },
  },
});
const list = (raw: string) =>
  raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
const number = (key: keyof typeof values, min: number, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(values[key]);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max)
    throw new Error(`--${key} must be between ${min} and ${max}`);
  return parsed;
};
const scenarios = list(values.scenarios!) as Scenario[];
for (const scenario of scenarios)
  if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario ${scenario}`);
const positive = (raw: string, label: string) =>
  list(raw).map((item) => {
    const parsed = Number(item);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid ${label} ${item}`);
    return parsed;
  });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const options: LoadOptions = {
  scenarios,
  instances: positive(values.instances!, 'instance count'),
  rates: positive(values.rate!, 'rate'),
  durationS: number('duration', 1, 3600),
  warmupS: number('warmup', 0, 600),
  seed: number('seed', 0, 2 ** 32 - 1),
  wallets: number('wallets', 1, 10000),
  openingCents: BigInt(Math.round(number('opening', 1, 1e12) * 100)),
  oversizedRatio: number('oversized-ratio', 0, 1),
  duplicateRatio: number('duplicate-ratio', 0, 0.95),
  duplicateWindow: number('duplicate-window', 1, 10000),
  maxInFlight: number('max-in-flight', 1, 10000),
  requestTimeoutMs: number('request-timeout', 100, 120000),
  sampleMs: number('sample-ms', 50, 10000),
  outboxDrainTimeoutMs: number('outbox-drain-timeout', 0, 3600000),
  outDir: resolve(values.out ?? `artifacts/load/${stamp}`),
};

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    console.error(`Interrupted (${signal}); stopping APIs and dropping disposable resources.`);
    void cleanupActiveRuns().finally(() => process.exit(130));
  });
await mkdir(options.outDir, { recursive: true });
const environment = await collectEnvironment(options);
await Bun.write(
  resolve(options.outDir, 'environment.json'),
  JSON.stringify(environment, null, 2) + '\n',
);
const runs: LoadRun[] = [];
const persist = async () => {
  await Bun.write(resolve(options.outDir, 'summary.json'), JSON.stringify(runs, null, 2) + '\n');
  await Bun.write(resolve(options.outDir, 'report.md'), renderReport(environment, runs));
};
for (const rate of options.rates)
  for (const scenario of options.scenarios)
    for (const instances of options.instances) {
      runs.push(await runScenario(scenario, instances, rate, options));
      await persist();
    }
const failed = runs.filter((run) => !run.invariants.ok);
console.log(`Load report: ${resolve(options.outDir, 'report.md')}`);
if (failed.length) {
  console.error(`Invariant failures: ${failed.map((run) => run.name).join(', ')}`);
  process.exitCode = 1;
}
