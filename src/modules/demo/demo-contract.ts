import type { MoneyProps } from '../../shared/domain/money';
import type { SubmissionReceipt } from '../wagering/domain/submission-receipt';
import type { WagerKind } from '../wagering/domain/wager-command';

export type DemoScenario = 'duplicate' | 'race' | 'out-of-order';
export interface DemoCommand {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}
export interface DemoSubmission {
  httpStatus: SubmissionReceipt['httpStatus'];
  originalReceipt: SubmissionReceipt;
}
export interface DemoScenarioResult {
  auditId: string;
  scenario: DemoScenario;
  providerId: string;
  amount: MoneyProps;
  transactions: DemoSubmission[];
}
