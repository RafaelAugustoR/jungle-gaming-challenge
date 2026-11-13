import { resetEvidence, runBunTests, printEvidence } from './run-bun-tests';

const evidencePath = process.env.BET_EVIDENCE_PATH ?? 'artifacts/issue-4/concurrency.json';
const recoveryPath = process.env.RECOVERY_EVIDENCE_PATH ?? 'artifacts/recovery/integrated.json';
await resetEvidence([evidencePath, recoveryPath]);
const { exitCode } = await runBunTests(
  ['tests/integration', 'tests/concurrency', 'tests/recovery'],
  {
    INTEGRATION: '1',
    RECOVERY: '1',
    BET_EVIDENCE_PATH: evidencePath,
    RECOVERY_EVIDENCE_PATH: recoveryPath,
  },
);
try {
  await printEvidence('BET_CONCURRENCY_EVIDENCE', evidencePath);
  await printEvidence('RECOVERY_EVIDENCE', recoveryPath);
  process.exitCode = exitCode;
} catch {
  console.error('Concurrency/recovery evidence was not generated; see the test failures above.');
  process.exitCode = exitCode || 1;
}
