import type { Money } from '../../../shared/domain/money';
import type { Wallet, WalletOpenResult } from '../domain/wallet';
export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
}
export interface WalletContext {
  actorId: string;
  correlationId: string;
}
export interface LedgerEntryView {
  id: string;
  transactionId: string;
  externalTransactionId: string | null;
  kind: string;
  direction: 'CREDIT' | 'DEBIT';
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: string;
}
export interface WalletStore {
  transaction<T>(work: (session: WalletSession) => Promise<T>): Promise<T>;
  find(id: string): Promise<Wallet | undefined>;
  ledger(id: string, after: number, upper: number, limit: number): Promise<LedgerEntryView[]>;
  reconcile(id: string): Promise<WalletReconciliationView | undefined>;
}
export interface WalletReconciliationView {
  storedBalance: string;
  calculatedBalance: string;
  difference: string;
  consistent: boolean;
  currency: string;
  checkedEntries: number;
}
export interface WalletReconciliationObserver {
  divergence(input: {
    walletId: string;
    actorId?: string;
    correlationId?: string;
    checkedEntries: number;
  }): void;
}
export interface LedgerQuery {
  limit: number;
  cursor?: { after: number; upper: number };
}

export interface WalletSession {
  openingResources(currency: string): Promise<{ counterpartAccountId: string; occurredAt: string }>;
  saveOpening(result: WalletOpenResult, context: WalletContext): Promise<void>;
}
