import { JsonLogger } from '../src/observability/logger';
import { loadConfig } from '../src/config/config';
import { openDatabase } from '../src/config/orm';

async function main() {
  const direction = process.argv[2];
  if (direction !== 'up' && direction !== 'down') throw new Error('Expected up or down');
  const orm = await openDatabase(loadConfig());
  try { await orm.getMigrator()[direction](); }
  finally { await orm.close(true); }
}
main().catch((error: unknown) => { new JsonLogger().error(error); process.exitCode = 1; });
