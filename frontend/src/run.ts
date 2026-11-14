// The state of one proof execution. Each status carries exactly what it has, so the views never
// have to guess: a running scenario has receipts arriving, a finished run has its verdict.
import type { ApiError } from './api';
import type { Verdict } from './proofs';
import type { DemoScenarioResult, Money, Reconciliation, TransactionView } from './types';

export interface ScenarioProgress {
  kind: 'scenario';
  before?: Money;
  after?: Money;
  result?: DemoScenarioResult;
  views: (TransactionView | undefined)[];
}
export interface ReconcileProgress {
  kind: 'reconcile';
  reconciliation?: Reconciliation;
}
export type Progress = ScenarioProgress | ReconcileProgress;

interface RunBase<P extends Progress> {
  startedAt: number;
  progress: P;
}
export type ProofRun<P extends Progress = Progress> =
  | (RunBase<P> & { status: 'running'; watching: boolean })
  | (RunBase<P> & { status: 'done'; verdict: Verdict })
  | (RunBase<P> & { status: 'error'; error: ApiError });

export const outcomeOf = (run?: ProofRun) =>
  run?.status === 'done' ? run.verdict.outcome : undefined;
