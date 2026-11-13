import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// The existing CI step runs this command. Keep execution data out of Git and
// publish it in the run's downloadable logs without changing workflow permissions.
const evidencePath = process.env.BET_EVIDENCE_PATH ?? 'artifacts/issue-4/concurrency.json';
await mkdir(dirname(evidencePath), { recursive: true });
await Bun.write(evidencePath, '');
const child = Bun.spawn([process.execPath, 'test', 'tests/integration', 'tests/concurrency'], {
  env: { ...process.env, INTEGRATION: '1', BET_EVIDENCE_PATH: evidencePath },
  stdout: 'inherit',
  stderr: 'inherit',
});
const status = await child.exited;
try {
  const evidence: unknown = await Bun.file(evidencePath).json();
  console.log('BET_CONCURRENCY_EVIDENCE', JSON.stringify(evidence));
  process.exitCode = status;
} catch {
  console.error('Concurrency evidence was not generated; see the test failures above.');
  process.exitCode = status || 1;
}
