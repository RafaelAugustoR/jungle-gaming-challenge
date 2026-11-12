import { createApplication } from '../../src/bootstrap/application';
import { loadConfig } from '../../src/config/config';
const app = await createApplication(loadConfig());
await app.listen(0, '127.0.0.1');
process.send?.({ ready: true, pid: process.pid, base: await app.getUrl() });
process.on('message', async (message: unknown) => {
  if (message === 'stop') {
    await app.close();
    process.exit(0);
  }
});
