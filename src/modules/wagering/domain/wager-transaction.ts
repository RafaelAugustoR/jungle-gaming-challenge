import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { EventContext } from '../../../shared/domain/events/integration-event';
import type { WalletMovementResult } from '../../wallets/domain/wallet';
import { isWagerKind, wagerPayloadHash, type WagerCommand } from './wager-command';
import type { SubmissionReceipt, WagerFailureCode } from './submission-receipt';
import { WagerTransactionProcessed, WagerTransactionRejected } from './events/wager-events';
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
  private event?: WagerTransactionProcessed | WagerTransactionRejected;
  private constructor(
    private readonly identity: Readonly<
      Omit<WagerSnapshot, 'status' | 'failureCode' | 'processedAt' | 'receipt'>
    >,
    private state: Readonly<TransactionState>,
    private processedAt?: string,
    private receipt?: SubmissionReceipt,
  ) {}
  static create(input: {
    command: WagerCommand;
    idempotencyKey: string;
    createdAt: string;
  }): WagerTransaction {
    const { command, idempotencyKey, createdAt } = input;
    if (
      !isWagerKind(command.kind) ||
      (command.kind === 'BET' && command.referenceExternalTransactionId !== undefined) ||
      ![
        command.providerId,
        command.externalTransactionId,
        command.playerId,
        command.walletId,
        command.roundId,
        command.gameId,
        idempotencyKey,
      ].every(
        (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 128,
      ) ||
      command.money.isNegative()
    )
      throw new DomainError('INVALID_PAYLOAD');
    return new WagerTransaction(
      Object.freeze({
        id: crypto.randomUUID(),
        command: Object.freeze({ ...command }),
        idempotencyKey,
        payloadHash: wagerPayloadHash(command),
        createdAt,
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
  complete(outcome: WalletMovementResult, at: string, context: EventContext): void {
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
          message: 'Wallet balance is insufficient for this wager',
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
    return { httpStatus: 422, body: { ...structuredClone(receipt.body), idempotentReplay } };
  }
  get resultEvent(): WagerTransactionProcessed | WagerTransactionRejected {
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
