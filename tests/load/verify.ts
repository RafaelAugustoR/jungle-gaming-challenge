import { ledgerAudit, ledgerAuditPassed, type LedgerAudit } from '../support/ledger-audit';
import {
  centsToAmount,
  expectedBalances,
  type FinalState,
  type Plan,
  type PlannedOperation,
} from './plan';
import type { RequestRecord } from './stats';
import type { Wallet } from './submission';

const originalIndex = (plan: Plan, record: RequestRecord) => {
  const op = plan.operations[record.index]!;
  return op.duplicateOf ?? op.index;
};

async function inBatches<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size)
    await Promise.all(items.slice(i, i + size).map(work));
}

/**
 * Final state of every unique operation: one never sent (no copy issued) is not applied;
 * otherwise it comes from any definitive response (original or replay), and uncertain outcomes
 * are read back. SQL counts later cross-check all three cases.
 */
export async function resolveFinalStates(
  plan: Plan,
  records: RequestRecord[],
  readBack: (op: PlannedOperation) => Promise<FinalState>,
) {
  const states = new Map<number, FinalState>();
  const issued = new Set<number>();
  for (const record of records) {
    const original = originalIndex(plan, record);
    if (record.outcome !== 'not_issued') issued.add(original);
    if (record.state) states.set(original, record.state);
  }
  const uncertain: PlannedOperation[] = [];
  let neverSent = 0;
  for (const op of plan.operations) {
    if (op.duplicateOf !== undefined || states.has(op.index)) continue;
    if (issued.has(op.index)) uncertain.push(op);
    else {
      neverSent++;
      states.set(op.index, 'NOT_APPLIED');
    }
  }
  await inBatches(uncertain, 16, async (op) => {
    states.set(op.index, await readBack(op));
  });
  return { states, readBack: uncertain.length, neverSent };
}
export type FinalStates = Awaited<ReturnType<typeof resolveFinalStates>>;

/** Unique operations whose copies produced more than one non-replay business result. */
export function duplicateFirstEffects(plan: Plan, records: RequestRecord[]) {
  const firstEffects = new Map<number, number>();
  for (const record of records)
    if (record.outcome === 'processed' || record.outcome === 'rejected') {
      const original = originalIndex(plan, record);
      firstEffects.set(original, (firstEffects.get(original) ?? 0) + 1);
    }
  return [...firstEffects.values()].filter((count) => count > 1).length;
}

export interface VerifyDependencies {
  wallets: Wallet[];
  sql: (query: string) => Promise<any[]>;
  reconcile: (walletId: string) => Promise<{
    status: number;
    body: {
      consistent?: boolean;
      storedBalance?: { amount: string };
      calculatedBalance?: { amount: string };
    };
  }>;
}

export async function checkInvariants(
  plan: Plan,
  records: RequestRecord[],
  resolution: FinalStates,
  deps: VerifyDependencies,
) {
  const { states } = resolution;
  const expected = expectedBalances(plan, states).map(centsToAmount);
  const reconciliation: { ok: boolean; expected?: string; stored?: string; calculated?: string }[] =
    [];
  await inBatches(
    deps.wallets.map((wallet, i) => ({ wallet, i })),
    16,
    async ({ wallet, i }) => {
      const { status, body } = await deps.reconcile(wallet.id);
      reconciliation[i] = {
        ok:
          status === 200 &&
          body.consistent === true &&
          body.storedBalance?.amount === expected[i] &&
          body.calculatedBalance?.amount === expected[i],
        expected: expected[i],
        stored: body.storedBalance?.amount,
        calculated: body.calculatedBalance?.amount,
      };
    },
  );
  const counts = { PROCESSED: 0, REJECTED: 0, NOT_APPLIED: 0 };
  for (const state of states.values()) counts[state]++;
  const oversizedProcessed = [...states].filter(
    ([index, state]) => state === 'PROCESSED' && plan.operations[index]!.oversized,
  ).length;
  const [database] = await deps.sql(`select
      (select count(*)::int from wagering.transactions where kind<>'OPENING' and status='PROCESSED') processed,
      (select count(*)::int from wagering.transactions where kind<>'OPENING' and status='REJECTED') rejected,
      (select count(*)::int from wagering.transactions where kind<>'OPENING') transactions,
      (select count(*)::int from wagering.journal) journal_entries`);
  const audit: LedgerAudit = await ledgerAudit(deps.sql);
  const openingEntries = plan.options.openingCents > 0n ? deps.wallets.length : 0;
  const checks = {
    reconciledWallets: reconciliation.every((r) => r.ok),
    transactionsMatchUniqueOperations: database.transactions === counts.PROCESSED + counts.REJECTED,
    processedMatches: database.processed === counts.PROCESSED,
    rejectedMatches: database.rejected === counts.REJECTED,
    journalEntriesMatch: database.journal_entries === openingEntries + counts.PROCESSED,
    ledgerAudit: ledgerAuditPassed(audit),
    noDuplicateFinancialEffect: duplicateFirstEffects(plan, records) === 0,
    oversizedNeverProcessed: oversizedProcessed === 0,
  };
  return {
    completed: true as const,
    ok: Object.values(checks).every(Boolean),
    checks,
    finalStates: counts,
    readBackAfterUncertainResponse: resolution.readBack,
    neverSent: resolution.neverSent,
    database,
    audit,
    reconciliation: {
      wallets: reconciliation.length,
      consistent: reconciliation.filter((r) => r.ok).length,
      failures: reconciliation.filter((r) => !r.ok).slice(0, 10),
    },
  };
}

/** Either the verification ran (and may have failed checks) or the harness could not finish it. */
export type Verification =
  | Awaited<ReturnType<typeof checkInvariants>>
  | { completed: false; ok: false; error: string };

export function harnessFailure(error: unknown): Verification {
  return {
    completed: false,
    ok: false,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  };
}
