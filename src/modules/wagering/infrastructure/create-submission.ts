import type { AppConfig } from '../../../config/config';
import { SubmitWagerTransaction } from '../application/submit-wager-transaction';
import type { WageringStore } from '../application/wagering-store';
import { ReferenceRetryPolicy } from '../domain/reference-retry';
export function createSubmission(store: WageringStore, config: AppConfig) {
  return new SubmitWagerTransaction(
    store,
    new Set(Object.values(config.providerClients)),
    new ReferenceRetryPolicy({
      ttlMs: config.referenceTtlMs,
      baseMs: config.referenceBaseMs,
      maxMs: config.referenceMaxMs,
    }),
  );
}
