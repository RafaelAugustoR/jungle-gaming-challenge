import type { Outcome } from './classify';

export interface RequestRecord {
  index: number;
  instance: number;
  phase: 'warmup' | 'measure';
  /** Milliseconds relative to the start of the schedule. */
  scheduledMs: number;
  sentMs?: number;
  completedMs?: number;
  latencyMs?: number;
  httpStatus?: number;
  outcome: Outcome;
  failureCode?: string;
  error?: string;
}

/** Nearest-rank percentile; returns null when there is no sample. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const round = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);

export function latency(values: number[]) {
  return {
    count: values.length,
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    p99: round(percentile(values, 99)),
    max: round(values.length ? values.reduce((a, b) => (b > a ? b : a)) : null),
  };
}

export function summarize(
  records: RequestRecord[],
  window: { windowStartMs: number; windowEndMs: number; instances: number },
) {
  const measured = records.filter((r) => r.phase === 'measure');
  const issued = measured.filter((r) => r.outcome !== 'not_issued');
  const completed = issued.filter((r) => r.completedMs !== undefined);
  const outcomes: Record<Outcome, number> = {
    processed: 0,
    rejected: 0,
    replay: 0,
    pending: 0,
    conflict: 0,
    error: 0,
    not_issued: 0,
  };
  for (const record of measured) outcomes[record.outcome]++;
  const windowSeconds = (window.windowEndMs - window.windowStartMs) / 1000;
  const lastCompletion = completed.reduce(
    (last, r) => (r.completedMs! > last ? r.completedMs! : last),
    window.windowEndMs,
  );
  const elapsedSeconds = (lastCompletion - window.windowStartMs) / 1000;
  const latencies = completed.map((r) => r.latencyMs!);
  const byOutcome = (outcome: Outcome) =>
    latency(completed.filter((r) => r.outcome === outcome).map((r) => r.latencyMs!));
  const scheduleLag = issued.map((r) => r.sentMs! - r.scheduledMs);
  return {
    windowSeconds,
    scheduled: measured.length,
    issued: issued.length,
    notIssued: outcomes.not_issued,
    completed: completed.length,
    outcomes,
    failureCodes: countBy(measured.filter((r) => r.failureCode).map((r) => r.failureCode!)),
    httpStatuses: countBy(issued.map((r) => String(r.httpStatus ?? 'transport'))),
    offeredRps: measured.length / windowSeconds,
    issuedRps: issued.length / windowSeconds,
    completedRps: completed.length / elapsedSeconds,
    financialRps: (outcomes.processed + outcomes.rejected) / elapsedSeconds,
    errorRate: issued.length ? (outcomes.error + outcomes.conflict) / issued.length : 0,
    drainAfterWindowMs: Math.round(lastCompletion - window.windowEndMs),
    latencyMs: latency(latencies),
    /** From the scheduled instant: includes generator/backlog delay hidden by service latency. */
    intendedLatencyMs: latency(completed.map((r) => r.completedMs! - r.scheduledMs)),
    latencyByOutcomeMs: {
      processed: byOutcome('processed'),
      rejected: byOutcome('rejected'),
      replay: byOutcome('replay'),
      error: byOutcome('error'),
    },
    scheduleLagMs: latency(scheduleLag),
    perInstance: Array.from({ length: window.instances }, (_, instance) => {
      const mine = issued.filter((r) => r.instance === instance);
      return {
        instance,
        issued: mine.length,
        p95: round(
          percentile(
            mine.filter((r) => r.latencyMs !== undefined).map((r) => r.latencyMs!),
            95,
          ),
        ),
      };
    }),
  };
}
export type RunSummary = ReturnType<typeof summarize>;

function countBy(values: string[]) {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
