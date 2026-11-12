import { loadMigrationConfig } from '../../src/config/config';
import { openDatabase } from '../../src/config/orm';

export async function disposableDatabase() {
  const config = loadMigrationConfig();
  const admin = await openDatabase(config);
  const name = `test_${crypto.randomUUID().replaceAll('-', '')}`;
  const url = new URL(config.databaseUrl);
  url.pathname = `/${name}`;
  await admin.em.execute(`create database ${name}`);
  const owner = await openDatabase({ ...config, databaseUrl: url.toString() });
  try {
    await owner.getMigrator().up();
  } catch (error) {
    await owner.close(true);
    await admin.em.execute(`drop database ${name}`);
    await admin.close(true);
    throw error;
  }
  url.username = 'jungle_runtime';
  url.password = 'runtime-demo-only';
  return {
    owner,
    config: { ...config, databaseUrl: url.toString() },
    close: async () => {
      await owner.close(true);
      await admin.em.execute(`drop database ${name}`);
      await admin.close(true);
    },
  };
}
