// Bounded operational demonstration, not a throughput benchmark (Issue #13).
import { humanToken, providerToken } from '../tests/support/keycloak';
import { loadMigrationConfig } from '../src/config/config';
import { openDatabase } from '../src/config/orm';
import { createSqsClient } from '../src/config/sqs';
import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { mkdir } from 'node:fs/promises';

const base = process.env.OBSERVABILITY_API_URL ?? 'http://127.0.0.1:3000';
const output = process.env.OBSERVABILITY_EVIDENCE_DIR ?? 'artifacts/issue-11';
await mkdir(output, { recursive: true });
const [demo, provider] = await Promise.all([humanToken('demo-operator'), providerToken('a')]);
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});
const walletResponse = await fetch(`${base}/wallets`, {
  method: 'POST',
  headers: headers(demo),
  body: JSON.stringify({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: '1000.00', currency: 'BRL' },
  }),
});
if (walletResponse.status !== 201)
  throw new Error(`Wallet create failed: ${walletResponse.status}`);
const wallet = (await walletResponse.json()) as { id: string; playerId: string };
const orm = await openDatabase(loadMigrationConfig());
const sqs = createSqsClient(loadMigrationConfig());
const command = (amount: string) => ({
  providerId: 'provider-a',
  externalTransactionId: crypto.randomUUID(),
  walletId: wallet.id,
  playerId: wallet.playerId,
  roundId: 'observability-evidence',
  gameId: 'evidence-game',
  kind: 'BET',
  money: { amount, currency: 'BRL' },
});
async function submit(body: ReturnType<typeof command>, key = crypto.randomUUID()) {
  const response = await fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: { ...headers(provider), 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  return {
    httpStatus: response.status,
    body: (await response.json()) as { status: string; idempotentReplay: boolean },
  };
}
const scrape = async () => {
  const r = await fetch(`${base}/internal/metrics`, { headers: headers(demo) });
  if (r.status !== 200) throw new Error(`Scrape ${r.status}`);
  return r.text();
};
const counter = (text: string, name: string) =>
  Number(text.match(new RegExp(`^${name}\\{[^\\n]*\\} ([0-9.]+)$`, 'm'))?.[1] ?? 0);
try {
  const acceptedCommand = command('20.00'),
    key = crypto.randomUUID();
  const accepted = await submit(acceptedCommand, key),
    replay = await submit(acceptedCommand, key),
    rejected = await submit(command('2000.00'));
  if (
    accepted.httpStatus !== 200 ||
    replay.body.idempotentReplay !== true ||
    rejected.httpStatus !== 422
  )
    throw new Error('Unexpected initial outcomes');
  // Let Prometheus establish baselines before the second wave, so increase/rate panels are meaningful.
  await Bun.sleep(11000);
  const wave = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      i % 4 === 0
        ? submit(command('2000.00'))
        : i % 4 === 1
          ? submit(acceptedCommand, key)
          : submit(command('1.00')),
    ),
  );
  const before = counter(await scrape(), 'wallet_lock_conflicts_total');
  const lock = orm.em.fork();
  await lock.begin();
  await lock.execute('select id from wagering.wallets where id=? for update', [wallet.id]);
  let contended: Awaited<ReturnType<typeof submit>>;
  try {
    const request = submit(command('1.00'));
    const timeout = Date.now() + 12000;
    while (counter(await scrape(), 'wallet_lock_conflicts_total') <= before) {
      if (Date.now() > timeout) throw new Error('No real PostgreSQL lock conflict was observed');
      await Bun.sleep(100);
    }
    await lock.commit();
    contended = await request;
    if (contended.httpStatus !== 200) throw new Error(`Lock recovery ${contended.httpStatus}`);
  } finally {
    if (lock.isInTransaction()) await lock.rollback();
  }
  const queue = await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }));
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queue.QueueUrl,
      MessageGroupId: wallet.id,
      MessageDeduplicationId: crypto.randomUUID(),
      MessageBody: JSON.stringify({
        messageId: crypto.randomUUID(),
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          ...command('1.00'),
          providerId: 'unknown-evidence-provider',
          idempotencyKey: crypto.randomUUID(),
        },
      }),
    }),
  );
  await Bun.sleep(11000);
  const reconciliationResponse = await fetch(`${base}/wallets/${wallet.id}/reconciliation`, {
    method: 'POST',
    headers: headers(demo),
  });
  const reconciliation = (await reconciliationResponse.json()) as {
    consistent: boolean;
    storedBalance: { amount: string };
    calculatedBalance: { amount: string };
  };
  if (
    reconciliationResponse.status !== 200 ||
    !reconciliation.consistent ||
    reconciliation.storedBalance.amount !== '969.00' ||
    reconciliation.calculatedBalance.amount !== '969.00'
  )
    throw new Error('Demonstration wallet does not reconcile to the scripted balance');
  const metrics = await scrape();
  await Bun.write(`${output}/loaded.prom`, metrics);
  const snapshot = {
    at: new Date().toISOString(),
    walletId: wallet.id,
    requests: 24,
    accepted: accepted.httpStatus,
    replay: replay.body.idempotentReplay,
    rejected: rejected.httpStatus,
    wave: {
      processed: wave.filter((r) => r.body.status === 'PROCESSED').length,
      rejected: wave.filter((r) => r.body.status === 'REJECTED').length,
    },
    contended: contended.httpStatus,
    reconciliation,
  };
  await Bun.write(`${output}/load.json`, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(JSON.stringify(snapshot));
} finally {
  sqs.destroy();
  await orm.close(true);
}
