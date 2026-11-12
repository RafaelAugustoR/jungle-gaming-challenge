import { createApplication } from './application';

async function main() {
  const app = await createApplication();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
  console.log(JSON.stringify({ level: 'info', event: 'application_started' }));
}
main().catch(() => {
  console.error(JSON.stringify({ level: 'error', event: 'startup_failed' }));
  process.exitCode = 1;
});
