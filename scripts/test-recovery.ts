import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Sequential suites keep the failure timeline readable and isolate each database.
// Existing proofs remain executable; the final scenario composes their production seams.
const directory = resolve(process.env.RECOVERY_ARTIFACT_DIR ?? 'artifacts/recovery');
await mkdir(directory, { recursive: true });
const evidencePath = resolve(directory, 'integrated.json');
await Bun.write(evidencePath, ''); // never report evidence from an earlier successful run
const phases = [
  {
    name: 'migrations-and-constraints',
    files: [
      'tests/integration/infrastructure.test.ts',
      'tests/integration/wallet-schema.test.ts',
      'tests/integration/wallet-chain.test.ts',
      'tests/integration/reference-schema.test.ts',
      'tests/integration/command-schema.test.ts',
    ],
  },
  { name: 'financial-concurrency', files: ['tests/concurrency'] },
  {
    name: 'delivery-and-recovery',
    files: [
      'tests/integration/command-process.test.ts',
      'tests/integration/command-idempotency.test.ts',
      'tests/integration/command-dlq.test.ts',
      'tests/integration/command-references.test.ts',
      'tests/integration/outbox.test.ts',
      'tests/integration/pending-references.test.ts',
    ],
  },
  { name: 'integrated-recovery', files: ['tests/recovery/integrated.test.ts'] },
];
const results = [];
const environment = { bun: Bun.version, platform: process.platform, arch: process.arch };
await Bun.write(
  resolve(directory, 'summary.json'),
  JSON.stringify({ completed: false, environment, phases: [] }, null, 2) + '\n',
);
await Bun.write(resolve(directory, 'http-concurrency.json'), '');
for (const phase of phases) {
  await Bun.write(resolve(directory, `${phase.name}.stdout.log`), '');
  await Bun.write(resolve(directory, `${phase.name}.stderr.log`), '');
}
for (const phase of phases) {
  console.log('RECOVERY_PHASE', phase.name);
  const started = Date.now();
  const child = Bun.spawn([process.execPath, 'test', '--bail', ...phase.files], {
    env: {
      ...process.env,
      INTEGRATION: '1',
      RECOVERY: '1',
      RECOVERY_EVIDENCE_PATH: evidencePath,
      BET_EVIDENCE_PATH: resolve(directory, 'http-concurrency.json'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const copy = async (
    stream: ReadableStream<Uint8Array>,
    target: Pick<typeof process.stdout, 'write'>,
  ) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
      target.write(chunk);
    }
    return Buffer.concat(chunks);
  };
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    copy(child.stdout, process.stdout),
    copy(child.stderr, process.stderr),
  ]);
  await Bun.write(resolve(directory, `${phase.name}.stdout.log`), stdout);
  await Bun.write(resolve(directory, `${phase.name}.stderr.log`), stderr);
  results.push({ phase: phase.name, exitCode, durationMs: Date.now() - started });
  await Bun.write(
    resolve(directory, 'summary.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        environment,
        completed: results.length === phases.length && exitCode === 0,
        phases: results,
      },
      null,
      2,
    ) + '\n',
  );
  if (exitCode !== 0) {
    process.exitCode = exitCode || 1;
    break;
  }
}
if (!process.exitCode) {
  const evidence: unknown = await Bun.file(evidencePath).json();
  console.log('RECOVERY_EVIDENCE', JSON.stringify(evidence));
  console.log(`Recovery evidence: ${directory}`);
}
