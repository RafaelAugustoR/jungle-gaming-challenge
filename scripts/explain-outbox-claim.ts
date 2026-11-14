/**
 * Diagnostic: builds an outbox backlog in a disposable database and prints EXPLAIN ANALYZE of
 * the real publishable-head query (PUBLISHABLE_HEADS). Requires the Compose infrastructure.
 *
 *   bun scripts/explain-outbox-claim.ts --bets 3000 --published 0.5
 *   bun scripts/explain-outbox-claim.ts --bets 3000 --published 0.5 --baseline
 *   bun scripts/explain-outbox-claim.ts --bets 10 --wallets 300 --published 0.5
 *
 * --bets per wallet, --wallets with that backlog, --published fraction of each wallet's events
 * already published. --baseline drops Migration202611140010's partial index to reproduce the
 * plan before it.
 */
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/config/orm';
import { PUBLISHABLE_HEADS } from '../src/messaging/outbox/outbox-repository';
import { SubmitWagerTransaction } from '../src/modules/wagering/application/submit-wager-transaction';
import { ReferenceRetryPolicy } from '../src/modules/wagering/domain/reference-retry';
import { WageringRepository } from '../src/modules/wagering/infrastructure/persistence/wagering-repository';
import { Wallets } from '../src/modules/wallets/application/wallets';
import { WalletRepository } from '../src/modules/wallets/infrastructure/persistence/wallet-repository';
import { Money } from '../src/shared/domain/money';
import { disposableDatabase } from '../tests/support/database';

const { values } = parseArgs({
  options: {
    bets: { type: 'string', default: '3000' },
    wallets: { type: 'string', default: '1' },
    published: { type: 'string', default: '0.5' },
    limit: { type: 'string', default: '20' },
    baseline: { type: 'boolean', default: false },
  },
});
const bets = Number(values.bets);
const walletCount = Number(values.wallets);
const published = Number(values.published);
const limit = Number(values.limit);

const database = await disposableDatabase();
const runtime = await openDatabase(database.config);
const owner = (query: string, params: unknown[] = []) =>
  database.owner.em.fork().execute(query, params);
try {
  const wallets = new Wallets(new WalletRepository(runtime), { divergence() {} });
  const submit = new SubmitWagerTransaction(
    new WageringRepository(runtime, database.config),
    new Set(['provider-a']),
    new ReferenceRetryPolicy({ ttlMs: 900000, baseMs: 1000, maxMs: 30000 }),
  );
  const started = performance.now();
  for (let w = 0; w < walletCount; w++) {
    const wallet = await wallets.create(
      { playerId: crypto.randomUUID(), initialBalance: Money.create('1000000.00', 'BRL') },
      { actorId: crypto.randomUUID(), correlationId: crypto.randomUUID() },
    );
    for (let i = 0; i < bets; i++) {
      const id = crypto.randomUUID();
      await submit.execute(
        {
          providerId: 'provider-a',
          externalTransactionId: id,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'r',
          gameId: 'g',
          kind: 'BET',
          money: Money.create('1.00', 'BRL'),
        },
        id,
        { correlationId: crypto.randomUUID() },
        { channel: 'http' },
      );
    }
  }
  // Publish the oldest fraction of every aggregate, as a publisher that kept partially up would.
  await owner(
    `update wagering.outbox o set published_at=clock_timestamp() from (
       select aggregate_id,max(sequence) total from wagering.outbox group by aggregate_id
     ) a where a.aggregate_id=o.aggregate_id and o.sequence<=floor(a.total*?)`,
    [published],
  );
  if (values.baseline) await owner('drop index wagering.outbox_unpublished_by_aggregate');
  await owner('analyze wagering.outbox');
  const [shape] = await owner(
    `select count(*)::int events,count(*) filter (where published_at is null)::int pending,
       count(distinct aggregate_id)::int aggregates from wagering.outbox`,
  );
  console.log(
    JSON.stringify({
      bets,
      wallets: walletCount,
      published,
      baseline: values.baseline,
      ...shape,
      seedMs: Math.round(performance.now() - started),
    }),
  );
  const plan = await owner(`explain (analyze, buffers) ${PUBLISHABLE_HEADS}`, [limit]);
  for (const row of plan) console.log(row['QUERY PLAN']);
} finally {
  await runtime.close(true);
  await database.close();
}
