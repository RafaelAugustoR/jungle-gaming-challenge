import type { TransactionView } from '../../src/modules/wagering/application/wagering-store';
import type { DemoScenarioResult, DemoSubmission } from '../../src/modules/demo/demo-contract';
import type { TransactionKind } from '../../src/modules/wagering/domain/wager-command';
import type { WagerFailureCode } from '../../src/modules/wagering/domain/submission-receipt';
import type { TransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';

export type {
  DemoScenarioResult,
  DemoSubmission,
  TransactionKind,
  TransactionStatus,
  TransactionView,
  WagerFailureCode,
};
export type Money = { amount: string; currency: string };
export type Wallet = { id: string; playerId: string; balance: Money; version: number };
export type LedgerEntry = {
  id: string;
  transactionId: string;
  kind: TransactionKind;
  externalTransactionId: string | null;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: string;
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export type Reconciliation = {
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
};
