import { createApplication } from './application';
import { loadConfig } from '../config/config';
import { JsonLogger } from '../observability/logger';

async function main() {
  const config = loadConfig();
  const app = await createApplication(config);
  try { await app.listen(config.port, '0.0.0.0'); }
  catch (error) { await app.close(); throw error; }
  new JsonLogger().log('application_started');
}
main().catch((error: unknown) => {
  new JsonLogger().error(error);
  process.exitCode = 1;
});
