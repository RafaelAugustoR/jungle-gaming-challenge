import { resolve } from 'node:path';
import { discoverTests, printEvidence, resetEvidence, runBunTests } from './run-bun-tests';

const directory = resolve(process.env.RECOVERY_ARTIFACT_DIR ?? 'artifacts/recovery');
const evidencePath = resolve(directory, 'integrated.json');
const betPath = resolve(directory, 'http-concurrency.json');
const schemas = await discoverTests([
  'tests/integration/*schema.test.ts',
  'tests/integration/infrastructure*.test.ts',
  'tests/integration/wallet-chain*.test.ts',
]);
const delivery = await discoverTests([
  'tests/integration/command-*.test.ts',
  'tests/integration/outbox*.test.ts',
  'tests/integration/pending-references*.test.ts',
]);
const phases = [
  { name: 'migrations-and-constraints', files: schemas },
  { name: 'financial-concurrency', files: ['tests/concurrency'] },
  { name: 'delivery-and-recovery', files: delivery.filter((file) => !schemas.includes(file)) },
  { name: 'integrated-recovery', files: ['tests/recovery'] },
];
await resetEvidence([
  evidencePath,
  betPath,
  ...phases.flatMap((phase) => [
    `${directory}/${phase.name}.stdout.log`,
    `${directory}/${phase.name}.stderr.log`,
  ]),
]);
const results: { phase: string; exitCode: number; durationMs: number }[] = [];
const environment = { bun: Bun.version, platform: process.platform, arch: process.arch };
const summary = async (completed: boolean) =>
  Bun.write(
    resolve(directory, 'summary.json'),
    JSON.stringify(
      { at: new Date().toISOString(), environment, completed, phases: results },
      null,
      2,
    ) + '\n',
  );
await summary(false);
for (const phase of phases) {
  console.log('RECOVERY_PHASE', phase.name);
  const result = await runBunTests(
    phase.files,
    {
      INTEGRATION: '1',
      RECOVERY: '1',
      RECOVERY_EVIDENCE_PATH: evidencePath,
      BET_EVIDENCE_PATH: betPath,
    },
    { bail: true, logPrefix: resolve(directory, phase.name) },
  );
  results.push({ phase: phase.name, ...result });
  await summary(results.length === phases.length && result.exitCode === 0);
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode || 1;
    break;
  }
}
if (!process.exitCode) {
  await printEvidence('RECOVERY_EVIDENCE', evidencePath);
  console.log(`Recovery evidence: ${directory}`);
}
