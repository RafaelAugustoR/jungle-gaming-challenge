import type { InboxMessage, InboxMessageProps } from '../../../messaging/domain/inbox-message';
import type { WagerReference } from '../domain/wager-step';
import type { TransactionKind, WagerKind } from '../domain/wager-command';
import type { Wallet, WalletChange } from '../../wallets/domain/wallet';
import type {
  TransactionState,
  TransactionStatus,
  WagerTransaction,
} from '../domain/wager-transaction';
import type { SubmissionReceipt } from '../domain/submission-receipt';
import type { MoneyProps } from '../../../shared/domain/money';
export interface TransactionView extends TransactionState {
  transactionId: string;
  providerId: string | null;
  externalTransactionId: string | null;
  playerId: string;
  walletId: string;
  roundId: string | null;
  gameId: string | null;
  kind: TransactionKind;
  money: MoneyProps;
  balance?: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  createdAt: string;
  processedAt: string | null;
  originalReceipt: SubmissionReceipt | null;
}
export interface TransactionFilter {
  walletId?: string;
  status?: TransactionStatus;
  kind?: TransactionKind;
  providerId?: string;
  limit: number;
  cursor?: TransactionCursorPosition;
}
export interface TransactionCursorPosition {
  createdAt: string;
  id: string;
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
  /** Received command message; recorded as processed atomically with its transaction. */
  inbox?: Omit<InboxMessageProps, 'transactionId'>;
  signal?: AbortSignal;
  channel: 'http' | 'sqs';
}
export interface WageringSession {
  recordInbox(message: InboxMessage): Promise<void>;
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
