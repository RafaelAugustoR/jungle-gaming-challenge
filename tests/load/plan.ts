/** Deterministic workload plans: the same options and seed always yield the same operations. */
export const SCENARIOS = ['hot-wallet', 'distributed', 'duplicates'] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const isScenario = (value: string): value is Scenario =>
  (SCENARIOS as readonly string[]).includes(value);

/** Larger than any balance a load wallet can reach, so the rejection is known before the run. */
export const OVERSIZED_BET = '9000000000000000.00';

export interface PlanOptions {
  scenario: Scenario;
  seed: number;
  operations: number;
  wallets: number;
  openingCents: bigint;
  oversizedRatio: number;
  duplicateRatio: number;
  duplicateWindow: number;
}
export interface PlannedOperation {
  index: number;
  walletIndex: number;
  kind: 'BET' | 'WIN';
  amount: string;
  oversized: boolean;
  externalTransactionId: string;
  idempotencyKey: string;
  roundId: string;
  /** Index of the original operation this submission replays with the same key and body. */
  duplicateOf?: number;
}
export interface Plan {
  options: PlanOptions;
  wallets: number;
  operations: PlannedOperation[];
}
export type FinalState = 'PROCESSED' | 'REJECTED' | 'NOT_APPLIED';

/** mulberry32: tiny, well-distributed and reproducible across runtimes. */
export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function centsToAmount(cents: bigint) {
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

export function buildPlan(options: PlanOptions): Plan {
  const next = random(options.seed);
  const integer = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const wallets = options.scenario === 'hot-wallet' ? 1 : options.wallets;
  const operations: PlannedOperation[] = [];
  const originals: number[] = [];
  for (let index = 0; index < options.operations; index++) {
    if (
      options.scenario === 'duplicates' &&
      originals.length > 0 &&
      next() < options.duplicateRatio
    ) {
      const recent = originals.slice(-options.duplicateWindow);
      const source = operations[recent[integer(0, recent.length - 1)]!]!;
      operations.push({ ...source, index, duplicateOf: source.index });
      continue;
    }
    const oversized = next() < options.oversizedRatio;
    const kind = oversized || next() < 0.7 ? 'BET' : 'WIN';
    // BET 1.00–20.00 and WIN 1.00–30.00: a small net debit that never drains a load wallet.
    const cents = BigInt(kind === 'BET' ? integer(100, 2000) : integer(100, 3000));
    const id = `load-${options.scenario}-${options.seed}-${index}`;
    operations.push({
      index,
      walletIndex: integer(0, wallets - 1),
      kind,
      amount: oversized ? OVERSIZED_BET : centsToAmount(cents),
      oversized,
      externalTransactionId: id,
      idempotencyKey: `${id}-key`,
      roundId: `round-${Math.floor(index / 10)}`,
    });
    originals.push(index);
  }
  return { options, wallets, operations };
}

/** Balance each wallet must hold given the final state of every unique planned operation. */
export function expectedBalances(plan: Plan, finalStates: Map<number, FinalState>) {
  const balances = Array.from({ length: plan.wallets }, () => plan.options.openingCents);
  for (const [index, state] of finalStates) {
    if (state !== 'PROCESSED') continue;
    const op = plan.operations[index]!;
    const cents = BigInt(op.amount.replace('.', ''));
    balances[op.walletIndex]! += op.kind === 'BET' ? -cents : cents;
  }
  return balances;
}
