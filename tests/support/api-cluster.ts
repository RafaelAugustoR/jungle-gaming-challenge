import { resolve } from 'node:path';
import type { AppConfig } from '../../src/config/config';
export async function apiProcess(config: AppConfig, name: string) {
  const databaseUrl = new URL(config.databaseUrl);
  databaseUrl.searchParams.set('application_name', name);
  let resolveReady!: (value: { pid: number; base: string }) => void;
  const ready = new Promise<{ pid: number; base: string }>((resolve) => {
    resolveReady = resolve;
  });
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'api-process.ts')], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl.toString(),
      KEYCLOAK_ISSUER: config.keycloakIssuer,
      KEYCLOAK_JWKS_URL: config.keycloakJwksUrl,
      PROVIDER_CLIENTS: JSON.stringify(config.providerClients),
      SQS_ENDPOINT: config.sqsEndpoint,
    },
    stdout: 'ignore',
    stderr: 'inherit',
    ipc(message: { ready?: boolean; pid: number; base: string }) {
      if (message.ready) resolveReady(message);
    },
  });
  let timeout: ReturnType<typeof setTimeout>;
  try {
    const address = await Promise.race([
      ready,
      child.exited.then((code) => {
        throw new Error(`API exited before readiness: ${code}`);
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('API readiness timeout')), 15000);
      }),
    ]);
    return {
      ...address,
      stop: async () => {
        child.send('stop');
        await child.exited;
      },
    };
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timeout!);
  }
}
