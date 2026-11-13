import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// The existing CI step runs this command. Keep execution data out of Git and
// publish it in the run's downloadable logs without changing workflow permissions.
const evidencePath = process.env.BET_EVIDENCE_PATH ?? 'artifacts/issue-4/concurrency.json';
await mkdir(dirname(evidencePath), { recursive: true });
await Bun.write(evidencePath, '');
const recoveryPath = process.env.RECOVERY_EVIDENCE_PATH ?? 'artifacts/recovery/integrated.json';
await mkdir(dirname(recoveryPath), { recursive: true });
await Bun.write(recoveryPath, '');
const child = Bun.spawn(
  [process.execPath, 'test', 'tests/integration', 'tests/concurrency', 'tests/recovery'],
  {
    env: {
      ...process.env,
      INTEGRATION: '1',
      RECOVERY: '1',
      BET_EVIDENCE_PATH: evidencePath,
      RECOVERY_EVIDENCE_PATH: recoveryPath,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  },
);
const status = await child.exited;
try {
  const evidence: unknown = await Bun.file(evidencePath).json();
  console.log('BET_CONCURRENCY_EVIDENCE', JSON.stringify(evidence));
  console.log('RECOVERY_EVIDENCE', JSON.stringify(await Bun.file(recoveryPath).json()));
  process.exitCode = status;
} catch {
  console.error('Concurrency/recovery evidence was not generated; see the test failures above.');
  process.exitCode = status || 1;
}
