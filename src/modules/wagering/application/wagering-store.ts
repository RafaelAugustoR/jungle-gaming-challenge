import type { WagerReference } from '../domain/wager-step';
import type { Wallet, WalletChange } from '../../wallets/domain/wallet';
import type { TransactionState, WagerTransaction } from '../domain/wager-transaction';
import type { MoneyProps } from '../../../shared/domain/money';
export interface TransactionView extends TransactionState {
  transactionId: string;
  providerId: string | null;
  externalTransactionId: string | null;
  playerId: string;
  walletId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  money: MoneyProps;
  balance?: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  createdAt: string;
  processedAt: string | null;
}
export interface WageringSession {
  lockWallet(id: string): Promise<Wallet | undefined>;
  findSubmission(providerId: string, key: string): Promise<WagerTransaction | undefined>;
  findReference(providerId: string, externalId: string): Promise<WagerReference | undefined>;
  externalExists(providerId: string, externalId: string): Promise<boolean>;
  resources(currency: string): Promise<{ counterpartAccountId: string; occurredAt: string }>;
  save(input: {
    transaction: WagerTransaction;
    wallet: Wallet;
    change?: WalletChange;
  }): Promise<void>;
}
export interface WageringStore {
  transaction<T>(work: (session: WageringSession) => Promise<T>): Promise<T>;
  find(id: string): Promise<TransactionView | undefined>;
  findExternal(providerId: string, externalId: string): Promise<TransactionView | undefined>;
}
