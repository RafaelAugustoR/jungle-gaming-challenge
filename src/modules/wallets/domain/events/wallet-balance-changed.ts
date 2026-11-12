import {
  IntegrationEvent,
  type EventContext,
} from '../../../../shared/domain/events/integration-event';
import type { MoneyProps } from '../../../../shared/domain/money';
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: 'CREDIT' | 'DEBIT';
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  private constructor(data: WalletBalanceChangedData, occurredAt: string, context: EventContext) {
    super(data.walletId, occurredAt, context, Object.freeze(data));
  }
  static create(data: WalletBalanceChangedData, occurredAt: string, context: EventContext) {
    return new WalletBalanceChanged(data, occurredAt, context);
  }
}
