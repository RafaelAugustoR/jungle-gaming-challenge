import {
  IntegrationEvent,
  type EventContext,
} from '../../../../shared/domain/events/integration-event';
import type { BetCommand } from '../wager-transaction';
import type { MoneyProps } from '../../../../shared/domain/money';
export interface WagerResultData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: 'BET';
  money: MoneyProps;
  balance: MoneyProps;
  failureCode?: string;
}
function resultData(
  command: BetCommand,
  transactionId: string,
  balance: MoneyProps,
): WagerResultData {
  return { ...command, money: command.money.toProps(), transactionId, balance };
}
export class WagerTransactionProcessed extends IntegrationEvent<WagerResultData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  private constructor(data: WagerResultData, at: string, context: EventContext) {
    super(data.walletId, at, context, Object.freeze(data));
  }
  static from(
    command: BetCommand,
    id: string,
    balance: MoneyProps,
    at: string,
    context: EventContext,
  ) {
    return new WagerTransactionProcessed(resultData(command, id, balance), at, context);
  }
}
export class WagerTransactionRejected extends IntegrationEvent<WagerResultData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  private constructor(data: WagerResultData, at: string, context: EventContext) {
    super(data.walletId, at, context, Object.freeze(data));
  }
  static from(
    command: BetCommand,
    id: string,
    balance: MoneyProps,
    failureCode: string,
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
