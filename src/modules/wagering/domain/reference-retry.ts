export interface ReferenceRetryOptions {
  ttlMs: number;
  baseMs: number;
  maxMs: number;
}
export class ReferenceRetryPolicy {
  constructor(
    readonly options: ReferenceRetryOptions,
    private readonly random: () => number = Math.random,
  ) {}
  deadline(acceptedAt: Date) {
    return new Date(acceptedAt.getTime() + this.options.ttlMs);
  }
  next(now: Date, attempts: number, deadline: Date) {
    const interval = Math.min(
      this.options.maxMs,
      this.options.baseMs * 2 ** Math.min(attempts, 30),
    );
    return new Date(
      Math.min(
        deadline.getTime(),
        now.getTime() + Math.floor(interval * (0.5 + this.random() / 2)),
      ),
    );
  }
}
