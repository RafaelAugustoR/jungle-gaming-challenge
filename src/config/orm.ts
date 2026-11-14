import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { resolve } from 'node:path';
import type { AppConfig } from './config';

/** Per-process connection pool; every API/worker instance opens its own. */
export const DATABASE_POOL = { min: 0, max: 5, acquireTimeoutMillis: 10000 } as const;

export function openDatabase(config: AppConfig) {
  return MikroORM.init({
    clientUrl: config.databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    connect: false,
    pool: { ...DATABASE_POOL },
    driverOptions: {
      connection: {
        connectionTimeoutMillis: config.databaseConnectTimeoutMs,
        application_name:
          new URL(config.databaseUrl).searchParams.get('application_name') ??
          `wagering-api-${process.pid}`,
      },
    },
    migrations: {
      path: resolve(import.meta.dir, '../../migrations'),
      glob: '!(*.d).{js,ts}',
      snapshot: false,
    },
  });
}
