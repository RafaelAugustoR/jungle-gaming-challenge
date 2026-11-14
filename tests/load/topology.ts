import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/config/sqs';
import { provisionEventQueues } from '../../scripts/provision-events';
import { apiProcess } from '../support/api-cluster';
import { disposableDatabase } from '../support/database';
import { humanToken, providerToken, tokenSource, type TokenSource } from '../support/keycloak';
import { spawnStaged } from '../support/spawn-staged';
import type { FinalState, PlannedOperation } from './plan';
import { parsePrometheus } from './prometheus';
import { authHeaders, PROVIDER_ID, submitWager, type Wallet } from './submission';

const open = new Set<() => Promise<void>>();
/** Stops child processes and drops disposable databases/queues of topologies still open. */
export async function closeOpenTopologies() {
  await Promise.allSettled([...open].map((close) => close()));
}

/**
 * Isolated system under test for one run, shaped like recoveryHarness(): a disposable database,
 * exclusive event queues, N real API processes, a production outbox publisher and fresh tokens.
 */
export async function loadTopology(
  instances: number,
  options: { requestTimeoutMs: number; tokenRefreshMs?: number },
  log: (line: string) => void,
) {
  const database = await disposableDatabase();
  const sqs = createSqsClient(database.config);
  const sql = (query: string, params: unknown[] = []) =>
    database.owner.em.fork().execute(query, params);
  const queues: string[] = [];
  const apis: Awaited<ReturnType<typeof apiProcess>>[] = [];
  const tokens: TokenSource[] = [];
  let publisher: ReturnType<typeof spawnStaged> | undefined;
  let closed: Promise<void> | undefined;
  // Idempotent so an interrupt handler and the normal path can both call it.
  const close = () =>
    (closed ??= (async () => {
      tokens.forEach((token) => token.close());
      await publisher?.stop('SIGTERM');
      await Promise.allSettled(apis.map((api) => api.stop()));
      await Promise.allSettled(
        queues.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))),
      );
      sqs.destroy();
      await database.close();
      open.delete(close);
    })());
  open.add(close);
  try {
    const queueName = `load-events-${crypto.randomUUID().slice(0, 8)}.fifo`;
    const events = await provisionEventQueues(sqs, queueName);
    queues.push(events.queue, events.dlq);
    for (let i = 0; i < instances; i++)
      apis.push(await apiProcess(database.config, `load-api-${i}`));
    const publisherUrl = new URL(database.config.databaseUrl);
    publisherUrl.searchParams.set('application_name', 'load-outbox-publisher');
    publisher = spawnStaged(
      new URL('../../src/bootstrap/outbox-publisher.ts', import.meta.url).pathname,
      {
        DATABASE_URL: publisherUrl.toString(),
        SQS_ENDPOINT: database.config.sqsEndpoint,
        OUTBOX_QUEUE_NAME: queueName,
        METRICS_PORT: '0',
      },
    );
    // Keycloak access tokens default to 5 minutes; refresh well before expiry.
    const refresh = (label: string) => ({
      refreshMs: options.tokenRefreshMs ?? 60000,
      onError: (error: unknown) =>
        log(
          `LOAD_TOKEN_REFRESH_FAILED ${label}: ${error instanceof Error ? error.message : error}`,
        ),
    });
    const provider = await tokenSource(() => providerToken('a'), refresh('provider-a'));
    tokens.push(provider);
    const demo = await tokenSource(() => humanToken('demo-operator'), refresh('demo-operator'));
    tokens.push(demo);
    const base = apis[0]!.base;

    return {
      sql,
      apiPids: apis.map((api) => api.pid),
      close,
      async createWallets(count: number, openingAmount: string) {
        const wallets: Wallet[] = [];
        for (let i = 0; i < count; i += 10)
          wallets.push(
            ...(await Promise.all(
              Array.from({ length: Math.min(10, count - i) }, async () => {
                const response = await fetch(`${base}/wallets`, {
                  method: 'POST',
                  headers: authHeaders(demo.current()),
                  body: JSON.stringify({
                    playerId: crypto.randomUUID(),
                    initialBalance: { amount: openingAmount, currency: 'BRL' },
                  }),
                });
                if (response.status !== 201)
                  throw new Error(`Wallet creation failed (${response.status})`);
                return (await response.json()) as Wallet;
              }),
            )),
          );
        return wallets;
      },
      submit: (instance: number, op: PlannedOperation, wallet: Wallet) =>
        submitWager(apis[instance]!.base, provider.current(), op, wallet, options.requestTimeoutMs),
      /** Current state by external identity; 404 means the operation was never applied. */
      async readBack(op: PlannedOperation): Promise<FinalState> {
        const response = await fetch(
          `${base}/providers/${PROVIDER_ID}/wagering/transactions/${op.externalTransactionId}`,
          { headers: authHeaders(provider.current()) },
        );
        if (response.status === 404) return 'NOT_APPLIED';
        const body = (await response.json().catch(() => ({}))) as { status?: string };
        if (response.status === 200 && (body.status === 'PROCESSED' || body.status === 'REJECTED'))
          return body.status;
        throw new Error(
          `Unresolved final state for ${op.externalTransactionId}: HTTP ${response.status} ${body.status}`,
        );
      },
      async reconcile(walletId: string) {
        const response = await fetch(`${base}/wallets/${walletId}/reconciliation`, {
          method: 'POST',
          headers: authHeaders(demo.current()),
        });
        return {
          status: response.status,
          body: (await response.json().catch(() => ({}))) as {
            consistent?: boolean;
            storedBalance?: { amount: string };
            calculatedBalance?: { amount: string };
          },
        };
      },
      async scrapeMetrics() {
        return Promise.all(
          apis.map(async (api) => {
            const response = await fetch(`${api.base}/internal/metrics`, {
              headers: authHeaders(demo.current()),
            });
            if (!response.ok) throw new Error(`Metrics scrape failed (${response.status})`);
            return parsePrometheus(await response.text());
          }),
        );
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type LoadTopology = Awaited<ReturnType<typeof loadTopology>>;
