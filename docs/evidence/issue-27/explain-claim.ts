// Diagnostic only: deep single-wallet outbox backlog, then EXPLAIN ANALYZE of the claim query.
// Usage (Compose infra up, .env configured): bun docs/evidence/issue-27/explain-claim.ts 3000 0.5 [index]
// Without "index" it drops Migration202611150010's partial index to reproduce the old plan;
// with "index" it keeps it. The query is the publishable-head selection of OutboxRepository.
const root = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const { disposableDatabase } = await import(`${root}/tests/support/database.ts`);
const { openDatabase } = await import(`${root}/src/config/orm.ts`);
const { WalletRepository } = await import(
  `${root}/src/modules/wallets/infrastructure/persistence/wallet-repository.ts`
);
const { Wallets } = await import(`${root}/src/modules/wallets/application/wallets.ts`);
const { Money } = await import(`${root}/src/shared/domain/money.ts`);
const { SubmitWagerTransaction } = await import(
  `${root}/src/modules/wagering/application/submit-wager-transaction.ts`
);
const { WageringRepository } = await import(
  `${root}/src/modules/wagering/infrastructure/persistence/wagering-repository.ts`
);
const { ReferenceRetryPolicy } = await import(
  `${root}/src/modules/wagering/domain/reference-retry.ts`
);

const bets = Number(process.argv[2] ?? 3000);
const publishedFraction = Number(process.argv[3] ?? 0.5);
const database = await disposableDatabase();
const runtime = await openDatabase(database.config);
try {
  const wallet = await new Wallets(new WalletRepository(runtime), { divergence() {} }).create(
    { playerId: crypto.randomUUID(), initialBalance: Money.create('1000000.00', 'BRL') },
    { actorId: crypto.randomUUID(), correlationId: crypto.randomUUID() },
  );
  // A few other wallets with small backlogs, like the distributed scenario.
  const others = [];
  for (let i = 0; i < 20; i++)
    others.push(
      await new Wallets(new WalletRepository(runtime), { divergence() {} }).create(
        { playerId: crypto.randomUUID(), initialBalance: Money.create('100.00', 'BRL') },
        { actorId: crypto.randomUUID(), correlationId: crypto.randomUUID() },
      ),
    );
  const submit = new SubmitWagerTransaction(
    new WageringRepository(runtime, database.config),
    new Set(['provider-a']),
    new ReferenceRetryPolicy({ ttlMs: 900000, baseMs: 1000, maxMs: 30000 }),
  );
  const started = performance.now();
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
  const owner = (q: string, p: unknown[] = []) => database.owner.em.fork().execute(q, p);
  const [{ total }] = await owner(
    'select count(*)::int total from wagering.outbox where aggregate_id=?',
    [wallet.id],
  );
  const cut = Math.floor(total * publishedFraction);
  await owner(
    'update wagering.outbox set published_at=clock_timestamp() where aggregate_id=? and sequence<=?',
    [wallet.id, cut],
  );
  // Baseline (default) reproduces the plan before Migration202611150010 by dropping its index.
  if (process.argv[4] !== 'index')
    await owner('drop index if exists wagering.outbox_unpublished_by_aggregate');
  await owner('analyze wagering.outbox');
  console.log(
    JSON.stringify({
      bets,
      hotWalletEvents: total,
      publishedInHotWallet: cut,
      otherWallets: others.length,
      seedMs: Math.round(performance.now() - started),
    }),
  );
  const claim = `
        select o.event_id from wagering.outbox o
          where o.published_at is null and o.blocked_at is null
            and o.next_attempt_at<=clock_timestamp()
            and (o.lease_until is null or o.lease_until<=clock_timestamp())
            and not exists(select from wagering.outbox previous
              where previous.aggregate_id=o.aggregate_id and previous.sequence<o.sequence and previous.published_at is null)
          order by o.occurred_at,o.event_id for update of o skip locked limit 20`;
  const plan = await owner(`explain (analyze, buffers, timing) ${claim}`);
  for (const row of plan) console.log(row['QUERY PLAN']);
} finally {
  await runtime.close(true);
  await database.close();
}
