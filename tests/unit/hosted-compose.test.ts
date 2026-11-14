import { expect, test } from 'bun:test';

// The hosted demo is a standalone Compose file on purpose: an overlay on compose.yaml would inherit
// every local credential that is not explicitly overridden. These checks keep the shared parts in sync.
type Service = {
  image?: string;
  command?: string[];
  ports?: string[];
  healthcheck?: { test: string[] };
  networks?: string[];
};
type ComposeFile = { services: Record<string, Service> };
const load = async (path: string) =>
  Bun.YAML.parse(await Bun.file(new URL(path, import.meta.url)).text()) as ComposeFile;
const local = await load('../../compose.yaml');
const hostedText = await Bun.file(
  new URL('../../deploy/hosted/compose.yaml', import.meta.url),
).text();
const hosted = Bun.YAML.parse(hostedText) as ComposeFile;
const reference = (name: string) => {
  const service = local.services[name];
  if (!service) throw new Error(`compose.yaml no longer defines ${name}`);
  return service;
};

test('hosted demo pins the same infrastructure images and health checks as the local stack', () => {
  for (const name of ['postgres', 'sqs', 'keycloak']) {
    expect(hosted.services[name]?.image).toBe(reference(name).image);
    expect(hosted.services[name]?.healthcheck?.test).toEqual(reference(name).healthcheck?.test);
  }
  expect(hosted.services.api?.healthcheck?.test).toEqual(reference('api').healthcheck?.test);
});

test('hosted demo runs every local worker with the same entrypoint', () => {
  for (const name of ['reference-worker', 'command-consumer', 'outbox-publisher', 'event-consumer'])
    expect(hosted.services[name]?.command).toEqual(reference(name).command);
});

test('hosted demo publishes only the TLS proxy and carries no local demo credentials', () => {
  const published = Object.entries(hosted.services)
    .filter(([, service]) => service.ports?.length)
    .map(([name]) => name);
  expect(published).toEqual(['caddy']);
  for (const [name, service] of Object.entries(hosted.services))
    if (name !== 'caddy') expect(service.networks ?? ['internal']).toEqual(['internal']);
  expect(hostedText).not.toMatch(/demo-only/);
});
