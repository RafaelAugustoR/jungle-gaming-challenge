import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LOAD_OPTIONS, runScenario, type LoadOptions } from '../load/runner';

const integration = process.env.INTEGRATION === '1' ? test : test.skip;
let outDir: string | undefined;
afterAll(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

// Tiny load keeps CI fast; it proves the harness end to end, not capacity.
const options = (dir: string): LoadOptions => ({
  ...DEFAULT_LOAD_OPTIONS,
  scenarios: ['duplicates'],
  instances: [3],
  rates: [30],
  durationS: 2,
  warmupS: 0.5,
  seed: 7,
  wallets: 4,
  openingCents: 1_000_00n,
  oversizedRatio: 0.1,
  duplicateRatio: 0.4,
  duplicateWindow: 5,
  maxInFlight: 64,
  outboxDrainTimeoutMs: 1000,
  outDir: dir,
});

integration(
  'load harness replays duplicates across three APIs and reconciles every wallet',
  async () => {
    outDir = await mkdtemp(join(tmpdir(), 'load-smoke-'));
    const run = await runScenario('duplicates', 3, 30, options(outDir), () => undefined);
    expect(new Set(run.apiPids).size).toBe(3);
    const { verification } = run;
    if (!verification.completed) throw new Error(verification.error);
    expect(verification.ok).toBe(true);
    expect(verification.reconciliation).toMatchObject({ wallets: 4, consistent: 4 });
    expect(verification.audit).toEqual({
      invalid_pairs: 0,
      partial_financial_effects: 0,
      missing_receipts: 0,
      pending_transactions: 0,
      invalid_event_sets: 0,
    });
    const { outcomes, perInstance } = run.summary;
    expect(run.summary.errors + outcomes.not_issued).toBe(0);
    expect(outcomes.replay).toBeGreaterThan(0);
    expect(outcomes.rejected).toBeGreaterThan(0);
    expect(verification.finalStates.REJECTED).toBe(verification.database.rejected);
    expect(perInstance.every((instance) => instance.issued > 0)).toBe(true);
    const raw = Bun.gunzipSync(
      new Uint8Array(await Bun.file(join(outDir, run.name, 'requests.ndjson.gz')).arrayBuffer()),
    );
    expect(new TextDecoder().decode(raw).trim().split('\n')).toHaveLength(run.operations);
  },
  60000,
);
