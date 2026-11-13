import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { EventContext } from '../../../shared/domain/events/integration-event';
import type { Wallet, WalletChange } from '../../wallets/domain/wallet';
import type { WagerCommand } from './wager-command';
import type { WagerPayload } from './wager-payload';
import {
  wagerFailureMessages,
  submissionHttpStatus,
  type SubmissionReceipt,
  type WagerFailureCode,
} from './submission-receipt';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  type WagerResultEvent,
} from './events/wager-events';
export type TransactionStatus =
  | 'PENDING'
  | 'PENDING_REFERENCE'
  | 'PROCESSED'
  | 'REJECTED'
  | 'FAILED';
export interface TransactionState {
  status: TransactionStatus;
  failureCode?: WagerFailureCode;
  referenceTransactionId?: string;
}
export type WagerOutcome =
  | { status: 'PROCESSED'; wallet: Wallet; change?: WalletChange; referenceTransactionId?: string }
  | { status: 'PENDING_REFERENCE'; wallet: Wallet; change?: never; referenceTransactionId?: never }
  | {
      status: 'REJECTED';
      wallet: Wallet;
      failureCode: WagerFailureCode;
      change?: never;
      referenceTransactionId?: string;
    };
const transitions: Record<TransactionStatus, readonly TransactionStatus[]> = {
  PENDING: ['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'],
  PENDING_REFERENCE: ['PROCESSED', 'REJECTED', 'FAILED'],
  PROCESSED: [],
  REJECTED: [],
  FAILED: [],
};
export interface WagerSnapshot extends TransactionState {
  id: string;
  command: WagerCommand;
  idempotencyKey: string;
  payloadHash: string;
  createdAt: string;
  processedAt?: string;
  receipt?: SubmissionReceipt;
}
export class WagerTransaction {
  private event?: WagerResultEvent;
  private constructor(
    private readonly identity: Readonly<
      Omit<
        WagerSnapshot,
        'status' | 'failureCode' | 'processedAt' | 'receipt' | 'referenceTransactionId'
      >
    >,
    private state: Readonly<TransactionState>,
    private processedAt?: string,
    private receipt?: SubmissionReceipt,
  ) {}
  static create(input: {
    payload: WagerPayload;
    idempotencyKey: string;
    createdAt: string;
  }): WagerTransaction {
    const { payload, idempotencyKey, createdAt } = input;
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128)
      throw new DomainError('INVALID_PAYLOAD');
    return new WagerTransaction(
      Object.freeze({
        id: crypto.randomUUID(),
        command: payload.command,
        idempotencyKey,
        payloadHash: payload.hash,
        createdAt,
      }),
      { status: 'PENDING' },
    );
  }
  static rehydrate(snapshot: WagerSnapshot): WagerTransaction {
    const { status, failureCode, referenceTransactionId, processedAt, receipt, ...identity } =
      snapshot;
    return new WagerTransaction(
      Object.freeze({ ...identity, command: Object.freeze({ ...identity.command }) }),
      Object.freeze({
        status,
        ...(failureCode ? { failureCode } : {}),
        ...(referenceTransactionId ? { referenceTransactionId } : {}),
      }),
      processedAt,
      receipt && structuredClone(receipt),
    );
  }
  get id() {
    return this.identity.id;
  }
  get command() {
    return this.identity.command;
  }
  get providerId() {
    return this.command.providerId;
  }
  get externalTransactionId() {
    return this.command.externalTransactionId;
  }
  get walletId() {
    return this.command.walletId;
  }
  get kind() {
    return this.command.kind;
  }
  get money() {
    return this.command.money;
  }
  get idempotencyKey() {
    return this.identity.idempotencyKey;
  }
  get payloadHash() {
    return this.identity.payloadHash;
  }
  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }
  transition(status: Exclude<TransactionStatus, 'PENDING'>, failureCode?: WagerFailureCode): void {
    if (
      !transitions[this.state.status].includes(status) ||
      ['REJECTED', 'FAILED'].includes(status) !== Boolean(failureCode)
    )
      throw new DomainError('INVALID_TRANSACTION_TRANSITION');
    this.state = Object.freeze({ status, ...(failureCode ? { failureCode } : {}) });
  }
  complete(outcome: WagerOutcome, at: string, context: EventContext): void {
    const balance = outcome.wallet.balance.toProps();
    const common = { transactionId: this.id, balance, idempotentReplay: false };
    if (outcome.status === 'REJECTED') {
      this.transition('REJECTED', outcome.failureCode);
      this.receipt ??= {
        httpStatus: submissionHttpStatus.REJECTED,
        body: {
          ...common,
          status: 'REJECTED',
          failureCode: outcome.failureCode,
          code: outcome.failureCode,
          message: wagerFailureMessages[outcome.failureCode],
          correlationId: context.correlationId,
        },
      };
      this.event = WagerTransactionRejected.from(
        this.command,
        this.id,
        balance,
        outcome.failureCode,
        at,
        context,
      );
    } else if (outcome.status === 'PENDING_REFERENCE') {
      this.transition('PENDING_REFERENCE');
      this.receipt ??= {
        httpStatus: submissionHttpStatus.PENDING_REFERENCE,
        body: { ...common, status: 'PENDING_REFERENCE' },
      };
      this.event = WagerTransactionPendingReference.from(
        this.command,
        this.id,
        balance,
        at,
        context,
      );
    } else {
      this.transition('PROCESSED');
      this.processedAt = at;
      this.receipt ??= {
        httpStatus: submissionHttpStatus.PROCESSED,
        body: { ...common, status: 'PROCESSED' },
      };
      this.event = WagerTransactionProcessed.from(this.command, this.id, balance, at, context);
    }
    if (outcome.status !== 'PENDING_REFERENCE' && outcome.referenceTransactionId)
      this.state = Object.freeze({
        ...this.state,
        referenceTransactionId: outcome.referenceTransactionId,
      });
  }
  getReceipt(idempotentReplay = false): SubmissionReceipt {
    const receipt = this.receipt;
    if (!receipt) throw new DomainError('INVALID_TRANSACTION_TRANSITION');
    const replay = structuredClone(receipt);
    replay.body.idempotentReplay = idempotentReplay;
    return replay;
  }
  get resultEvent(): WagerResultEvent {
    if (!this.event) throw new DomainError('INVALID_TRANSACTION_TRANSITION');
    return this.event;
  }
  toProps(): WagerSnapshot {
    return {
      ...this.identity,
      command: { ...this.command },
      ...this.state,
      processedAt: this.processedAt,
      receipt: this.receipt && structuredClone(this.receipt),
    };
  }
}
