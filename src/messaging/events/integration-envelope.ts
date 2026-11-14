import { Money } from '../../shared/domain/money';
import type { IntegrationEvent } from '../../shared/domain/events/integration-event';
import { WalletBalanceChanged } from '../../modules/wallets/domain/events/wallet-balance-changed';
import type { OpeningTransactionProcessed } from '../../modules/wallets/domain/events/opening-processed';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  type WagerResultEvent,
} from '../../modules/wagering/domain/events/wager-events';
import { isWagerKind } from '../../modules/wagering/domain/wager-command';
import { isUuid } from '../../shared/domain/is-uuid';
type Envelope<E extends IntegrationEvent<unknown>> =
  E extends IntegrationEvent<unknown>
    ? Omit<ReturnType<E['toJSON']>, 'eventType'> & { eventType: E['eventType']; sequence: number }
    : never;
export type IntegrationEnvelope = Envelope<
  WalletBalanceChanged | WagerResultEvent | OpeningTransactionProcessed
>;
export class InvalidIntegrationEvent extends Error {
  constructor() {
    super('INVALID_INTEGRATION_EVENT');
    this.name = 'InvalidIntegrationEvent';
  }
}

export function parseIntegrationEvent(raw: string): IntegrationEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InvalidIntegrationEvent();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidIntegrationEvent();
  const event = value as IntegrationEnvelope;
  if (
    !isUuid(event.eventId) ||
    !isUuid(event.aggregateId) ||
    typeof event.eventType !== 'string' ||
    !event.eventType ||
    ![
      WalletBalanceChanged.eventType,
      WagerTransactionProcessed.eventType,
      WagerTransactionRejected.eventType,
      WagerTransactionPendingReference.eventType,
    ].includes(event.eventType) ||
    !Number.isSafeInteger(event.version) ||
    event.version < 1 ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    typeof event.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    typeof event.correlationId !== 'string' ||
    !event.correlationId ||
    (event.causationId !== undefined && typeof event.causationId !== 'string') ||
    !event.data ||
    typeof event.data !== 'object' ||
    Array.isArray(event.data)
  )
    throw new InvalidIntegrationEvent();
  if (event.eventType === 'WalletBalanceChanged') {
    if (!Number.isSafeInteger(event.data.walletVersion) || event.data.walletVersion < 1)
      throw new InvalidIntegrationEvent();
    if (
      !isUuid(event.data.walletId) ||
      !isUuid(event.data.transactionId) ||
      !['CREDIT', 'DEBIT'].includes(event.data.direction)
    )
      throw new InvalidIntegrationEvent();
    try {
      Money.rehydrate(event.data.money);
      Money.rehydrate(event.data.balanceBefore);
      const balance = Money.rehydrate(event.data.balanceAfter);
      if (balance.isNegative()) throw new Error();
    } catch {
      throw new InvalidIntegrationEvent();
    }
  } else if (event.data.kind === 'OPENING') {
    // Internal OPENING result: processed only, and never with a provider identity.
    const data = event.data;
    const external = data as unknown as Record<string, unknown>;
    if (
      event.eventType !== WagerTransactionProcessed.eventType ||
      !isUuid(data.transactionId) ||
      !isUuid(data.walletId) ||
      typeof data.playerId !== 'string' ||
      !data.playerId ||
      ['providerId', 'externalTransactionId', 'roundId', 'gameId'].some((key) => key in external)
    )
      throw new InvalidIntegrationEvent();
    try {
      const money = Money.rehydrate(data.money);
      if (money.isZero() || money.isNegative() || Money.rehydrate(data.balance).isNegative())
        throw new Error();
    } catch {
      throw new InvalidIntegrationEvent();
    }
  } else {
    const data = event.data;
    if (
      !isUuid(data.transactionId) ||
      !isUuid(data.walletId) ||
      ![
        data.providerId,
        data.externalTransactionId,
        data.playerId,
        data.roundId,
        data.gameId,
      ].every((value) => typeof value === 'string') ||
      !isWagerKind(data.kind)
    )
      throw new InvalidIntegrationEvent();
    try {
      Money.rehydrate(data.money);
      Money.rehydrate(data.balance);
    } catch {
      throw new InvalidIntegrationEvent();
    }
  }
  return event;
}
