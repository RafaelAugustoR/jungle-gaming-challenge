import { Money, type MoneyProps } from '../../shared/domain/money';
export interface IntegrationEnvelope {
  eventId: string;
  aggregateId: string;
  eventType: string;
  version: number;
  occurredAt: string;
  correlationId: string;
  sequence: number;
  data: Record<string, unknown>;
}
export class InvalidIntegrationEvent extends Error {
  constructor() {
    super('INVALID_INTEGRATION_EVENT');
    this.name = 'InvalidIntegrationEvent';
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    typeof event.eventId !== 'string' ||
    !uuid.test(event.eventId) ||
    typeof event.aggregateId !== 'string' ||
    !uuid.test(event.aggregateId) ||
    typeof event.eventType !== 'string' ||
    !event.eventType ||
    event.eventType.length > 128 ||
    !Number.isSafeInteger(event.version) ||
    event.version < 1 ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    typeof event.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    typeof event.correlationId !== 'string' ||
    !event.correlationId ||
    !event.data ||
    typeof event.data !== 'object' ||
    Array.isArray(event.data)
  )
    throw new InvalidIntegrationEvent();
  if (event.eventType === 'WalletBalanceChanged') {
    if (!Number.isSafeInteger(event.data.walletVersion) || (event.data.walletVersion as number) < 1)
      throw new InvalidIntegrationEvent();
    try {
      const balance = Money.rehydrate(event.data.balanceAfter as MoneyProps);
      if (balance.isNegative()) throw new Error();
    } catch {
      throw new InvalidIntegrationEvent();
    }
  }
  return event;
}
