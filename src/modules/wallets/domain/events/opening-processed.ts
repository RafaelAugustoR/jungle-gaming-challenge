import {
  IntegrationEvent,
  type EventContext,
} from '../../../../shared/domain/events/integration-event';
import type { MoneyProps } from '../../../../shared/domain/money';

/**
 * Result data of the internal OPENING transaction. It has no provider identity (OPENING never
 * comes from a provider), so it is the `kind: 'OPENING'` variant of the processed-result data.
 */
export interface OpeningProcessedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  kind: 'OPENING';
  money: MoneyProps;
  balance: MoneyProps;
}

/**
 * `WagerTransactionProcessed` for the internal OPENING transaction (§11: every applied
 * transaction). Same event type and version as the provider result; consumers tell the two
 * apart by `data.kind`. It lives in the wallets module because wagering depends on wallets,
 * never the other way around.
 */
export class OpeningTransactionProcessed extends IntegrationEvent<OpeningProcessedData> {
  static readonly eventType = 'WagerTransactionProcessed';
  readonly eventType = OpeningTransactionProcessed.eventType;
  readonly version = 1;
  private constructor(data: OpeningProcessedData, occurredAt: string, context: EventContext) {
    super(data.walletId, occurredAt, context, Object.freeze(data));
  }
  static from(data: OpeningProcessedData, occurredAt: string, context: EventContext) {
    return new OpeningTransactionProcessed(data, occurredAt, context);
  }
}
