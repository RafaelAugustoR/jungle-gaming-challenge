import {
  IntegrationEvent,
  type EventContext,
} from '../../../../shared/domain/events/integration-event';
import type { WagerCommand, WagerKind } from '../wager-command';
import type { WagerFailureCode } from '../submission-receipt';
import type { MoneyProps } from '../../../../shared/domain/money';
export interface WagerResultData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: MoneyProps;
  balance: MoneyProps;
  failureCode?: WagerFailureCode;
}
function resultData(
  command: WagerCommand,
  transactionId: string,
  balance: MoneyProps,
): WagerResultData {
  return { ...command, money: command.money.toProps(), transactionId, balance };
}
export class WagerTransactionProcessed extends IntegrationEvent<WagerResultData> {
  static readonly eventType = 'WagerTransactionProcessed';
  readonly eventType = WagerTransactionProcessed.eventType;
  readonly version = 1;
  private constructor(data: WagerResultData, at: string, context: EventContext) {
    super(data.walletId, at, context, Object.freeze(data));
  }
  static from(
    command: WagerCommand,
    id: string,
    balance: MoneyProps,
    at: string,
    context: EventContext,
  ) {
    return new WagerTransactionProcessed(resultData(command, id, balance), at, context);
  }
}
export class WagerTransactionRejected extends IntegrationEvent<WagerResultData> {
  static readonly eventType = 'WagerTransactionRejected';
  readonly eventType = WagerTransactionRejected.eventType;
  readonly version = 1;
  private constructor(data: WagerResultData, at: string, context: EventContext) {
    super(data.walletId, at, context, Object.freeze(data));
  }
  static from(
    command: WagerCommand,
    id: string,
    balance: MoneyProps,
    failureCode: WagerFailureCode,
    at: string,
    context: EventContext,
  ) {
    return new WagerTransactionRejected(
      { ...resultData(command, id, balance), failureCode },
      at,
      context,
    );
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerResultData> {
  static readonly eventType = 'WagerTransactionPendingReference';
  readonly eventType = WagerTransactionPendingReference.eventType;
  readonly version = 1;
  private constructor(data: WagerResultData, at: string, context: EventContext) {
    super(data.walletId, at, context, Object.freeze(data));
  }
  static from(
    command: WagerCommand,
    id: string,
    balance: MoneyProps,
    at: string,
    context: EventContext,
  ) {
    return new WagerTransactionPendingReference(resultData(command, id, balance), at, context);
  }
}

export type WagerResultEvent =
  | WagerTransactionProcessed
  | WagerTransactionRejected
  | WagerTransactionPendingReference;
