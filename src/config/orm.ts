import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { resolve } from 'node:path';
import type { AppConfig } from './config';

export function openDatabase(config: AppConfig) {
  return MikroORM.init({
    clientUrl: config.databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    connect: false,
    pool: { min: 0, max: 5, acquireTimeoutMillis: 10000 },
    driverOptions: { connection: { connectionTimeoutMillis: config.databaseConnectTimeoutMs } },
    migrations: { path: resolve(import.meta.dir, '../../migrations'), glob: '!(*.d).{js,ts}', snapshot: false },
  });
}
