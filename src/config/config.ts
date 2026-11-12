export interface AppConfig {
  port: number;
  keycloakIssuer: string;
  keycloakJwksUrl: string;
  databaseUrl: string;
  sqsEndpoint: string;
  awsRegion: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  probeTimeoutMs: number;
  databaseConnectTimeoutMs: number;
}
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const integer = (key: string, fallback: string, max: number) => {
    const value = env[key] ?? fallback;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max)
      throw new Error(`Invalid ${key}`);
    return Number(value);
  };
  const url = (key: string, protocols: string[]) => {
    const value = env[key];
    try {
      if (!value || !protocols.includes(new URL(value).protocol)) throw new Error();
    } catch {
      throw new Error(`Invalid or missing ${key}`);
    }
    return value!;
  };
  if (Boolean(env.AWS_ACCESS_KEY_ID) !== Boolean(env.AWS_SECRET_ACCESS_KEY))
    throw new Error('AWS credentials must be supplied together');
  const urlWithDefault = (key: string, fallback: string) => {
    const value = env[key] ?? fallback;
    try {
      if (!['http:', 'https:'].includes(new URL(value).protocol)) throw new Error();
    } catch {
      throw new Error(`Invalid ${key}`);
    }
    return value;
  };
  return {
    keycloakIssuer: urlWithDefault('KEYCLOAK_ISSUER', 'http://localhost:18080/realms/jungle'),
    keycloakJwksUrl: urlWithDefault(
      'KEYCLOAK_JWKS_URL',
      `${env.KEYCLOAK_ISSUER || 'http://localhost:18080/realms/jungle'}/protocol/openid-connect/certs`,
    ),
    port: integer('PORT', '3000', 65535),
    databaseUrl: url('DATABASE_URL', ['postgres:', 'postgresql:']),
    sqsEndpoint: url('SQS_ENDPOINT', ['http:', 'https:']),
    awsRegion: env.AWS_REGION || 'us-east-1',
    awsAccessKeyId: env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    databaseConnectTimeoutMs: integer('DATABASE_CONNECT_TIMEOUT_MS', '5000', 60000),
    probeTimeoutMs: integer('PROBE_TIMEOUT_MS', '2000', 30000),
  };
}

export function loadMigrationConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  return loadConfig({ ...env, DATABASE_URL: env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL });
}
