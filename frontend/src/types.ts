import type { TransactionView } from '../../src/modules/wagering/application/wagering-store';
import type { DemoScenarioResult, DemoSubmission } from '../../src/modules/demo/demo-contract';

export type { TransactionView, DemoScenarioResult, DemoSubmission };
export type Money = { amount: string; currency: string };
export type Wallet = { id: string; playerId: string; balance: Money; version: number };
export type LedgerEntry = {
  id: string;
  transactionId: string;
  kind: string;
  externalTransactionId: string | null;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: string;
};
export type LedgerPage = { entries: LedgerEntry[]; nextCursor: string | null };
export type TransactionPage = { transactions: TransactionView[]; nextCursor: string | null };
export type Reconciliation = {
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
};
export type Role = 'viewer' | 'operator' | 'demo-operator';
