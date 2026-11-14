import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { loadConfig } from '../../src/config/config';
import { createApplication } from '../../src/bootstrap/application';

let app: INestApplication;
let base: string;
beforeAll(async () => {
  app = await createApplication(
    loadConfig({
      DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/invalid',
      SQS_ENDPOINT: 'http://127.0.0.1:1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
    }),
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
});

test('liveness is public and does not depend on infrastructure', async () => {
  const response = await fetch(`${base}/health/live`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('readiness returns 503 when dependencies are unreachable without affecting liveness', async () => {
  const response = await fetch(`${base}/health/ready`);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    status: 'unavailable',
    checks: { postgres: false, sqs: false },
  });
  expect((await fetch(`${base}/health/live`)).status).toBe(200);
});
