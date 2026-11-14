import { expect } from 'bun:test';
import { ledgerAudit } from './ledger-audit';
import { authHeaders, type RecoveryHarness } from './recovery-harness';

export async function assertRecovery(h: RecoveryHarness) {
  const { orm, sql, apis, demo, expected, facts, commands, events, drained } = h;
  // Every row in this disposable DB must be known and reconciled, not just sampled.
  await expect(
    orm.em.fork().transactional(async (em) => {
      await em.execute('update wagering.wallets set balance=balance+1 where id=?', [
        expected.keys().next().value!,
      ]);
    }),
  ).rejects.toThrow();
  await expect(
    orm.em.fork().execute('update wagering.journal set amount=amount'),
  ).rejects.toThrow();
  const walletRows = await sql('select id,balance::text,version from wagering.wallets order by id');
  expect(walletRows).toHaveLength(expected.size);
  const reconciled = [];
  for (const w of walletRows) {
    const response = await fetch(`${apis[0]!.base}/wallets/${w.id}/reconciliation`, {
      method: 'POST',
      headers: authHeaders(demo),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as Record<string, unknown>;
    expect(result).toMatchObject({
      consistent: true,
      storedBalance: { amount: expected.get(w.id), currency: 'BRL' },
      calculatedBalance: { amount: expected.get(w.id), currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
    });
    reconciled.push({ walletId: w.id, balance: w.balance, version: w.version, ...result });
  }
  const [delivery] = await sql(`select
      (select count(*)::int from wagering.outbox where published_at is null or blocked_at is not null or lease_token is not null) pending_events,
      (select count(*)::int from wagering.outbox o left join demo_consumer.event_inbox i on i.event_id=o.event_id where i.event_id is null) missing_deliveries,
      (select count(*)::int from wagering.wallets w join demo_consumer.event_projection p on p.aggregate_id=w.id where p.wallet_version<>w.version or (p.balance->>'amount')::numeric<>w.balance) stale_projections`);
  const invariants = {
    ...(await ledgerAudit(sql)),
    ...(delivery as {
      pending_events: number;
      missing_deliveries: number;
      stale_projections: number;
    }),
  };
  expect(invariants).toEqual({
    invalid_pairs: 0,
    partial_financial_effects: 0,
    missing_receipts: 0,
    pending_transactions: 0,
    pending_events: 0,
    missing_deliveries: 0,
    stale_projections: 0,
    invalid_event_sets: 0,
  });
  const [eventsAudit] = await sql(
    'select count(*)::int total,count(distinct event_id)::int unique_events from wagering.outbox',
  );
  expect(eventsAudit).toEqual({ total: facts.events, unique_events: facts.events });
  expect((await sql('select count(*)::int n from demo_consumer.event_inbox'))[0].n).toBe(
    eventsAudit.total,
  );
  expect((await sql('select count(*)::int n from demo_consumer.event_projection'))[0].n).toBe(
    expected.size,
  );
  const totals = await sql(
    `select currency,count(*)::int journal_entries,sum(amount)::text paired_amount from wagering.journal group by currency`,
  );
  expect(totals).toEqual([
    {
      currency: 'BRL',
      journal_entries: facts.journalEntries,
      paired_amount: facts.pairedAmount.toFixed(2),
    },
  ]);
  for (const queue of [commands.dlq, events.dlq]) await drained(queue);
  return {
    walletCount: expected.size,
    reconciled,
    invariants,
    events: eventsAudit,
    journalTotals: totals,
    commandQueueDrained: true,
    eventQueueDrained: true,
    dlqsEmpty: true,
  };
}
