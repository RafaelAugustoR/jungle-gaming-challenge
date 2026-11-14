type Sql = (query: string, params?: unknown[]) => Promise<any[]>;

export interface LedgerAudit {
  invalid_pairs: number;
  partial_financial_effects: number;
  missing_receipts: number;
  pending_transactions: number;
  invalid_event_sets: number;
}

/**
 * Financial invariants over a whole database, shared by the recovery audit (which expects zeros)
 * and the load verification (which reports them as checks). Every counter must be zero.
 */
export async function ledgerAudit(sql: Sql): Promise<LedgerAudit> {
  const [row] = await sql(`select
      (select count(*)::int from wagering.journal j join wagering.accounts d on d.id=j.debit_account_id join wagering.accounts c on c.id=j.credit_account_id where j.amount<=0 or d.id=c.id or d.currency<>j.currency or c.currency<>j.currency) invalid_pairs,
      (select count(*)::int from wagering.transactions t where (t.status='PROCESSED' and t.kind<>'LOSS' and t.amount>0 and (select count(*) from wagering.journal j where j.transaction_id=t.id)<>1) or (t.status<>'PROCESSED' and exists(select from wagering.journal j where j.transaction_id=t.id))) partial_financial_effects,
      (select count(*)::int from wagering.transactions t where t.kind<>'OPENING' and (select count(*) from wagering.submission_receipts r where r.transaction_id=t.id)<>1) missing_receipts,
      (select count(*)::int from wagering.transactions t where t.status in ('PENDING','PENDING_REFERENCE')) pending_transactions,
      (select count(*)::int from wagering.transactions t where t.kind<>'OPENING' and ((select count(*) from wagering.outbox o where o.transaction_id=t.id and o.event_type=case t.status when 'PROCESSED' then 'WagerTransactionProcessed' else 'WagerTransactionRejected' end)<>1 or (select count(*) from wagering.outbox o where o.transaction_id=t.id and o.event_type='WalletBalanceChanged')<>case when t.status='PROCESSED' then 1 else 0 end)) invalid_event_sets`);
  return row as LedgerAudit;
}

export const ledgerAuditPassed = (audit: LedgerAudit) =>
  Object.values(audit).every((count) => count === 0);
