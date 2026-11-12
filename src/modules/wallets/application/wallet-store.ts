import type { Money } from '../../../shared/domain/money';
import type { Wallet } from '../domain/wallet';
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
}
export interface LedgerQuery {
  limit: number;
  cursor?: { after: number; upper: number };
}

export interface WalletSession {
  openingResources(currency: string): Promise<{ counterpartAccountId: string; occurredAt: string }>;
  saveOpening(result: ReturnType<typeof Wallet.open>, context: WalletContext): Promise<void>;
}
