import { DomainError } from '../domain/errors/domain-error';
export function parseUuid(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw new DomainError('INVALID_PAYLOAD');
  return value.toLowerCase();
}
