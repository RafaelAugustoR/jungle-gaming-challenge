export interface ProcessSignal {
  stage: string;
  pid: number;
  messageId?: string;
  depth?: number;
  eventId?: string;
  token?: string;
  base?: string;
}

/** One lifecycle for the real API/worker subprocesses used by recovery tests. */
export function spawnStaged(
  entry: string,
  env: Record<string, string | undefined>,
  args: string[] = [],
) {
  const signals: ProcessSignal[] = [];
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    ipc(raw: ProcessSignal & { ready?: boolean }) {
      signals.push({ ...raw, stage: raw.ready ? 'ready' : raw.stage, pid: raw.pid ?? child.pid });
    },
  });
  // Drain both pipes immediately, including while a child is paused at a failpoint.
  const logs = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  async function exit(timeoutMs = 10000) {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    try {
      return { code: await child.exited, logs: await Promise.all([logs, errors]) };
    } finally {
      clearTimeout(timer);
    }
  }
  async function stop(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
    if (child.exitCode === null) child.kill(signal);
    return (await exit(5000)).code;
  }
  return {
    child,
    pid: child.pid,
    signals,
    logs,
    errors,
    exit,
    stop,
    release(message: unknown = 'release') {
      child.send(message);
    },
    async wait(stage: string, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (!signals.some((message) => message.stage === stage)) {
        if (child.exitCode !== null || Date.now() >= deadline) {
          await stop('SIGKILL');
          throw new Error(
            `Process ${child.pid} missing ${stage}: ${(await Promise.all([logs, errors])).join('\n')}`,
          );
        }
        await Bun.sleep(10);
      }
      return signals.find((message) => message.stage === stage)!;
    },
  };
}
