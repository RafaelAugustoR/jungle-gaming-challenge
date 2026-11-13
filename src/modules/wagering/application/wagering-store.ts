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
  originalReceipt: { httpStatus: number; body: Record<string, unknown> } | null;
}
export interface TransactionFilter {
  walletId?: string;
  status?: string;
  kind?: string;
  providerId?: string;
  limit: number;
  cursor?: TransactionCursorPosition;
}
export interface TransactionCursorPosition {
  upperCreatedAt: string;
  upperId: string;
  afterCreatedAt: string;
  afterId: string;
}
export interface PendingReference {
  transaction: WagerTransaction;
  deadline: string;
  attempts: number;
  context: { correlationId: string; causationId?: string };
}
export interface PendingReferenceCandidate {
  transactionId: string;
  walletId: string;
}
export interface SubmissionExecution {
  inbox?: { consumerName: string; messageId: string; hash: string };
  signal?: AbortSignal;
}
export interface WageringSession {
  recordInbox(
    inbox: NonNullable<SubmissionExecution['inbox']>,
    transactionId: string,
  ): Promise<void>;
  referenceSchedule(id: string): Promise<{ attempts: number; now: string } | undefined>;
  scheduleReference(
    id: string,
    schedule: { deadline: string; nextAttemptAt: string },
    context: { correlationId: string; causationId?: string },
  ): Promise<void>;
  pendingReference(id: string): Promise<PendingReference | undefined>;
  rescheduleReference(id: string, nextAttemptAt: string): Promise<void>;
  savePendingResult(
    input: { transaction: WagerTransaction; wallet: Wallet; change?: WalletChange },
    at: string,
  ): Promise<void>;
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
  dueReferences(limit: number): Promise<PendingReferenceCandidate[]>;
  transaction<T>(work: (session: WageringSession) => Promise<T>, signal?: AbortSignal): Promise<T>;
  find(id: string): Promise<TransactionView | undefined>;
  findExternal(providerId: string, externalId: string): Promise<TransactionView | undefined>;
  list(filter: TransactionFilter): Promise<{
    transactions: TransactionView[];
    next: TransactionCursorPosition | null;
  }>;
}
