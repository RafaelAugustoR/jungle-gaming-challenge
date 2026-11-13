import type { AppConfig } from '../../src/config/config';
import { spawnStaged } from './spawn-staged';
export async function apiProcess(config: AppConfig, name: string) {
  const databaseUrl = new URL(config.databaseUrl);
  databaseUrl.searchParams.set('application_name', name);
  const process = spawnStaged(new URL('api-process.ts', import.meta.url).pathname, {
    DATABASE_URL: databaseUrl.toString(),
    KEYCLOAK_ISSUER: config.keycloakIssuer,
    KEYCLOAK_JWKS_URL: config.keycloakJwksUrl,
    PROVIDER_CLIENTS: JSON.stringify(config.providerClients),
    SQS_ENDPOINT: config.sqsEndpoint,
  });
  try {
    const ready = await process.wait('ready', 15000);
    if (!ready.base) throw new Error('API readiness has no address');
    return {
      pid: process.pid,
      base: ready.base,
      async stop() {
        if (process.child.exitCode === null) process.release('stop');
        await process.exit(5000);
      },
    };
  } catch (error) {
    await process.stop('SIGKILL');
    throw error;
  }
}
