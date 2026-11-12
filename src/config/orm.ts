import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration202611120001 } from '../../migrations/Migration202611120001';

export function openDatabase() {
  return MikroORM.init({
    clientUrl: process.env.DATABASE_URL ?? 'postgresql://jungle:local-demo-only@127.0.0.1:55439/jungle',
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    connect: false,
    pool: { min: 0, max: 5, acquireTimeoutMillis: 2000 },
    driverOptions: { connection: { connectionTimeoutMillis: 2000, statement_timeout: 2000 } },
    migrations: { migrationsList: [Migration202611120001] },
  });
}
