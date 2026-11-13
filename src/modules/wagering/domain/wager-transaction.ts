import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { EventContext } from '../../../shared/domain/events/integration-event';
import type { Wallet } from '../../wallets/domain/wallet';
import type { WagerCommand } from './wager-command';
import type { WagerPayload } from './wager-payload';
import {
  wagerFailureMessages,
  type SubmissionReceipt,
  type WagerFailureCode,
} from './submission-receipt';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
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
}
export type WagerOutcome =
  | { status: 'PROCESSED'; wallet: Wallet }
  | { status: 'PENDING_REFERENCE'; wallet: Wallet }
  | { status: 'REJECTED'; wallet: Wallet; failureCode: WagerFailureCode };
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
  referenceTransactionId?: string;
  receipt?: SubmissionReceipt;
}
export class WagerTransaction {
  private event?:
    | WagerTransactionProcessed
    | WagerTransactionRejected
    | WagerTransactionPendingReference;
  private constructor(
    private readonly identity: Readonly<
      Omit<WagerSnapshot, 'status' | 'failureCode' | 'processedAt' | 'receipt'>
    >,
    private state: Readonly<TransactionState>,
    private processedAt?: string,
    private receipt?: SubmissionReceipt,
  ) {}
  static create(input: {
    payload: WagerPayload;
    idempotencyKey: string;
    createdAt: string;
    referenceTransactionId?: string;
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
        referenceTransactionId: input.referenceTransactionId,
      }),
      { status: 'PENDING' },
    );
  }
  static rehydrate(snapshot: WagerSnapshot): WagerTransaction {
    const { status, failureCode, processedAt, receipt, ...identity } = snapshot;
    return new WagerTransaction(
      Object.freeze({ ...identity, command: Object.freeze({ ...identity.command }) }),
      Object.freeze({ status, ...(failureCode ? { failureCode } : {}) }),
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
      this.receipt = {
        httpStatus: 422,
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
      this.receipt = { httpStatus: 202, body: { ...common, status: 'PENDING_REFERENCE' } };
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
      this.receipt = { httpStatus: 200, body: { ...common, status: 'PROCESSED' } };
      this.event = WagerTransactionProcessed.from(this.command, this.id, balance, at, context);
    }
  }
  getReceipt(idempotentReplay = false): SubmissionReceipt {
    const receipt = this.receipt;
    if (!receipt) throw new DomainError('INVALID_TRANSACTION_TRANSITION');
    if (receipt.httpStatus === 200)
      return { httpStatus: 200, body: { ...structuredClone(receipt.body), idempotentReplay } };
    if (receipt.httpStatus === 202)
      return { httpStatus: 202, body: { ...structuredClone(receipt.body), idempotentReplay } };
    return { httpStatus: 422, body: { ...structuredClone(receipt.body), idempotentReplay } };
  }
  get resultEvent():
    | WagerTransactionProcessed
    | WagerTransactionRejected
    | WagerTransactionPendingReference {
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
