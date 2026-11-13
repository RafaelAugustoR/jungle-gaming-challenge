import { isUuid } from '../domain/is-uuid';
import { DomainError } from '../domain/errors/domain-error';
export function parseUuid(value: string): string {
  if (!isUuid(value)) throw new DomainError('INVALID_PAYLOAD');
  return value.toLowerCase();
}
