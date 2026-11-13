import { identifier, parseWagerCommand } from '../../modules/wagering/application/wager-contract';
import { DomainError } from '../../shared/domain/errors/domain-error';
export function parseCommandEnvelope(body: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new DomainError('INVALID_PAYLOAD');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new DomainError('INVALID_PAYLOAD');
  const envelope = raw as Record<string, unknown>;
  if (
    Object.keys(envelope).some(
      (key) => !['messageId', 'type', 'occurredAt', 'data'].includes(key),
    ) ||
    envelope.type !== 'WagerTransactionRequested' ||
    typeof envelope.occurredAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T/.test(envelope.occurredAt) ||
    !Number.isFinite(Date.parse(envelope.occurredAt)) ||
    !envelope.data ||
    typeof envelope.data !== 'object' ||
    Array.isArray(envelope.data)
  )
    throw new DomainError('INVALID_PAYLOAD');
  const { idempotencyKey, ...data } = envelope.data as Record<string, unknown>;
  return {
    messageId: identifier(envelope.messageId),
    key: identifier(idempotencyKey),
    command: parseWagerCommand(data),
  };
}

export function diagnosticMessageId(body: string): string | undefined {
  try {
    return identifier((JSON.parse(body) as Record<string, unknown>)?.messageId);
  } catch {
    return undefined;
  }
}
