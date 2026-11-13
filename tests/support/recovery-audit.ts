import { expect } from 'bun:test';
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
  const [invariants] = await sql(`select
      (select count(*)::int from wagering.journal j join wagering.accounts d on d.id=j.debit_account_id join wagering.accounts c on c.id=j.credit_account_id where j.amount<=0 or d.id=c.id or d.currency<>j.currency or c.currency<>j.currency) invalid_pairs,
      (select count(*)::int from wagering.transactions t where (t.status='PROCESSED' and t.kind<>'LOSS' and t.amount>0 and (select count(*) from wagering.journal j where j.transaction_id=t.id)<>1) or (t.status<>'PROCESSED' and exists(select from wagering.journal j where j.transaction_id=t.id))) partial_financial_effects,
      (select count(*)::int from wagering.transactions t where t.kind<>'OPENING' and (select count(*) from wagering.submission_receipts r where r.transaction_id=t.id)<>1) missing_receipts,
      (select count(*)::int from wagering.transactions t where t.status in ('PENDING','PENDING_REFERENCE')) pending_transactions,
      (select count(*)::int from wagering.outbox where published_at is null or blocked_at is not null or lease_token is not null) pending_events,
      (select count(*)::int from wagering.outbox o left join demo_consumer.event_inbox i on i.event_id=o.event_id where i.event_id is null) missing_deliveries,
      (select count(*)::int from wagering.wallets w join demo_consumer.event_projection p on p.aggregate_id=w.id where p.wallet_version<>w.version or (p.balance->>'amount')::numeric<>w.balance) stale_projections,
      (select count(*)::int from wagering.transactions t where t.kind<>'OPENING' and ((select count(*) from wagering.outbox o where o.transaction_id=t.id and o.event_type=case t.status when 'PROCESSED' then 'WagerTransactionProcessed' else 'WagerTransactionRejected' end)<>1 or (select count(*) from wagering.outbox o where o.transaction_id=t.id and o.event_type='WalletBalanceChanged')<>case when t.status='PROCESSED' then 1 else 0 end)) invalid_event_sets`);
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
