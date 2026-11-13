import { integer as envInteger } from './integer';
export interface AppConfig {
  port: number;
  keycloakIssuer: string;
  keycloakTokenUrl: string;
  providerClients: Readonly<Record<string, string>>;
  demoProviderClientSecrets: Readonly<Record<string, string>>;
  keycloakJwksUrl: string;
  databaseUrl: string;
  sqsEndpoint: string;
  awsRegion: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  probeTimeoutMs: number;
  databaseConnectTimeoutMs: number;
  financialLockTimeoutMs: number;
  financialStatementTimeoutMs: number;
  financialDeadlineMs: number;
  referenceTtlMs: number;
  referenceBaseMs: number;
  referenceMaxMs: number;
  referencePollMs: number;
  referenceBatchSize: number;
}
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const integer = (key: string, fallback: string, max: number) =>
    envInteger(env, key, Number(fallback), max);
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
  let providerClients: Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(
      env.PROVIDER_CLIENTS || '{"provider-a":"provider-a","provider-b":"provider-b"}',
    );
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.entries(parsed).some(
        ([client, provider]) =>
          client === 'jungle-console' ||
          !client.trim() ||
          typeof provider !== 'string' ||
          !provider.trim(),
      )
    )
      throw new Error();
    providerClients = Object.freeze({ ...parsed }) as Readonly<Record<string, string>>;
  } catch {
    throw new Error('Invalid PROVIDER_CLIENTS');
  }
  let demoProviderClientSecrets: Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(env.DEMO_PROVIDER_CLIENT_SECRETS || '{}');
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.entries(parsed).some(
        ([provider, secret]) => !provider.trim() || typeof secret !== 'string' || !secret,
      )
    )
      throw new Error();
    demoProviderClientSecrets = Object.freeze({ ...parsed }) as Record<string, string>;
  } catch {
    throw new Error('Invalid DEMO_PROVIDER_CLIENT_SECRETS');
  }
  for (const provider of Object.keys(demoProviderClientSecrets))
    if (!Object.values(providerClients).includes(provider))
      throw new Error('Invalid DEMO_PROVIDER_CLIENT_SECRETS');
  return {
    providerClients,
    demoProviderClientSecrets,
    keycloakIssuer: urlWithDefault('KEYCLOAK_ISSUER', 'http://localhost:18080/realms/jungle'),
    keycloakTokenUrl: urlWithDefault(
      'KEYCLOAK_TOKEN_URL',
      `${env.KEYCLOAK_ISSUER || 'http://localhost:18080/realms/jungle'}/protocol/openid-connect/token`,
    ),
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
    financialLockTimeoutMs: integer('FINANCIAL_LOCK_TIMEOUT_MS', '3000', 60000),
    financialStatementTimeoutMs: integer('FINANCIAL_STATEMENT_TIMEOUT_MS', '5000', 60000),
    financialDeadlineMs: integer('FINANCIAL_DEADLINE_MS', '15000', 60000),
    referenceTtlMs: integer('REFERENCE_TTL_MS', '900000', 86400000),
    referenceBaseMs: integer('REFERENCE_BASE_MS', '1000', 60000),
    referenceMaxMs: integer('REFERENCE_MAX_MS', '30000', 60000),
    referencePollMs: integer('REFERENCE_POLL_MS', '500', 60000),
    referenceBatchSize: integer('REFERENCE_BATCH_SIZE', '50', 1000),
    probeTimeoutMs: integer('PROBE_TIMEOUT_MS', '2000', 30000),
  };
}

export function loadMigrationConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  return loadConfig({ ...env, DATABASE_URL: env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL });
}
