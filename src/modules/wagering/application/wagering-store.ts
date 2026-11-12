import type { Wallet } from '../../wallets/domain/wallet';
import type { JournalEntry } from '../../wallets/domain/journal-entry';
import type { WalletBalanceChanged } from '../../wallets/domain/events/wallet-balance-changed';
import type { BetCommand, TransactionState, WagerTransaction } from '../domain/wager-transaction';
import type { MoneyProps } from '../../../shared/domain/money';
import type {
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events/wager-events';

export interface SubmissionReceipt {
  httpStatus: 200 | 422;
  body: {
    transactionId: string;
    status: 'PROCESSED' | 'REJECTED';
    balance: MoneyProps;
    idempotentReplay: boolean;
    failureCode?: string;
    code?: string;
    message?: string;
    correlationId?: string;
  };
}
export interface AcceptedSubmission {
  hash: string;
  receipt: SubmissionReceipt;
}
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
  createdAt: string;
  processedAt: string | null;
}
export interface WageringSession {
  lockWallet(id: string): Promise<Wallet | undefined>;
  findSubmission(providerId: string, key: string): Promise<AcceptedSubmission | undefined>;
  externalExists(providerId: string, externalId: string): Promise<boolean>;
  resources(currency: string): Promise<{ counterpartAccountId: string; occurredAt: string }>;
  save(input: {
    command: BetCommand;
    key: string;
    hash: string;
    transaction: WagerTransaction;
    wallet: Wallet;
    receipt: SubmissionReceipt;
    occurredAt: string;
    entry?: JournalEntry;
    balanceEvent?: WalletBalanceChanged;
    resultEvent: WagerTransactionProcessed | WagerTransactionRejected;
  }): Promise<void>;
}
export interface WageringStore {
  transaction<T>(work: (session: WageringSession) => Promise<T>): Promise<T>;
  findSubmission(providerId: string, key: string): Promise<AcceptedSubmission | undefined>;
  externalExists(providerId: string, externalId: string): Promise<boolean>;
  find(id: string): Promise<TransactionView | undefined>;
  findExternal(providerId: string, externalId: string): Promise<TransactionView | undefined>;
}
