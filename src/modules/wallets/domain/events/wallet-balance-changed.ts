import {
  IntegrationEvent,
  type EventContext,
} from '../../../../shared/domain/events/integration-event';
import type { JournalEntry } from '../journal-entry';
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
  static from(entry: JournalEntry, occurredAt: string, context: EventContext) {
    const props = entry.toProps();
    return new WalletBalanceChanged(
      {
        walletId: props.walletId,
        transactionId: props.transactionId,
        direction: entry.direction,
        money: { amount: props.amount, currency: props.currency },
        balanceBefore: { amount: props.balanceBefore, currency: props.currency },
        balanceAfter: { amount: props.balanceAfter, currency: props.currency },
        walletVersion: props.walletVersion,
      },
      occurredAt,
      context,
    );
  }
}
