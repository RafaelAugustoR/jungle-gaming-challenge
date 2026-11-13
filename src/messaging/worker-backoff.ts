export class WorkerBackoff extends Error {
  constructor(readonly delayMs: number) {
    super('WORKER_BACKOFF');
    this.name = 'WorkerBackoff';
  }
}
