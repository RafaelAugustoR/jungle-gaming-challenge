export class WalletReconciliationMetrics {
  private divergences = 0;

  recordDivergence() {
    this.divergences += 1;
  }

  get divergenceCount() {
    return this.divergences;
  }
}
