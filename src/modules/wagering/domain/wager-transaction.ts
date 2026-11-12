import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { Money } from '../../../shared/domain/money';

export interface BetCommand {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET';
  money: Money;
}
export type TransactionStatus =
  | 'PENDING'
  | 'PENDING_REFERENCE'
  | 'PROCESSED'
  | 'REJECTED'
  | 'FAILED';
export interface TransactionState {
  status: TransactionStatus;
  failureCode?: string;
}
export class WagerTransaction {
  private constructor(
    readonly id: string,
    private state: Readonly<TransactionState>,
  ) {}
  static create(): WagerTransaction {
    return new WagerTransaction(crypto.randomUUID(), { status: 'PENDING' });
  }
  static rehydrate(id: string, state: TransactionState): WagerTransaction {
    return new WagerTransaction(id, Object.freeze({ ...state }));
  }
  transition(status: Exclude<TransactionStatus, 'PENDING'>, failureCode?: string): void {
    if (
      !['PENDING', 'PENDING_REFERENCE'].includes(this.state.status) ||
      (this.state.status === 'PENDING_REFERENCE' && status === 'PENDING_REFERENCE') ||
      ['REJECTED', 'FAILED'].includes(status) !== Boolean(failureCode)
    )
      throw new DomainError('INVALID_TRANSACTION_TRANSITION');
    this.state = Object.freeze({ status, ...(failureCode ? { failureCode } : {}) });
  }
  toProps(): TransactionState {
    return { ...this.state };
  }
}
