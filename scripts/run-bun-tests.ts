import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function resetEvidence(paths: string[]) {
  for (const path of paths) {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, '');
  }
}
export async function printEvidence(label: string, path: string) {
  console.log(label, JSON.stringify(await Bun.file(path).json()));
}
export async function discoverTests(patterns: string[]) {
  const files = new Set<string>();
  for (const pattern of patterns)
    for await (const file of new Bun.Glob(pattern).scan('.')) files.add(file);
  if (!files.size) throw new Error(`No tests match ${patterns.join(', ')}`);
  return [...files].sort();
}
export async function runBunTests(
  files: string[],
  env: Record<string, string>,
  options: { bail?: boolean; logPrefix?: string } = {},
) {
  const start = Date.now();
  const child = Bun.spawn(
    [process.execPath, 'test', ...(options.bail ? ['--bail'] : []), ...files],
    {
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
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
  if (options.logPrefix) {
    await Bun.write(`${options.logPrefix}.stdout.log`, stdout);
    await Bun.write(`${options.logPrefix}.stderr.log`, stderr);
  }
  return { exitCode, durationMs: Date.now() - start };
}
