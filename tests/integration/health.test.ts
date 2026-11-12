import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../../src/bootstrap/application';

let app: INestApplication;
let base: string;
beforeAll(async () => {
  app = await createApplication();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => { await app?.close(); });

test('liveness is public and does not depend on infrastructure', async () => {
  const response = await fetch(`${base}/health/live`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('readiness returns 503 when dependencies are unreachable without affecting liveness', async () => {
  const database = process.env.DATABASE_URL;
  const sqs = process.env.SQS_ENDPOINT;
  process.env.DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/invalid';
  process.env.SQS_ENDPOINT = 'http://127.0.0.1:1';
  try {
    const response = await fetch(`${base}/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unavailable', checks: { postgres: false, sqs: false } });
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
  } finally {
    if (database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = database;
    if (sqs === undefined) delete process.env.SQS_ENDPOINT; else process.env.SQS_ENDPOINT = sqs;
  }
});
