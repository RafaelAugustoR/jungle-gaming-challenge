import { isUuid } from '../../../shared/domain/is-uuid';
import { decodeCursor, encodeCursor } from '../../../shared/rest/opaque-cursor';
import type { TransactionFilter, TransactionCursorPosition } from '../application/wagering-store';

function filterScope(filter: TransactionFilter) {
  return {
    walletId: filter.walletId ?? null,
    status: filter.status ?? null,
    kind: filter.kind ?? null,
    providerId: filter.providerId ?? null,
    limit: filter.limit,
  };
}
function validPosition(value: unknown): value is TransactionCursorPosition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const position = value as Record<string, unknown>;
  if (
    Object.keys(position).sort().join(',') !== 'createdAt,id' ||
    typeof position.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(position.createdAt) ||
    !isUuid(position.id)
  )
    return false;
  const milliseconds = `${position.createdAt.slice(0, 23)}Z`;
  const instant = new Date(milliseconds);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === milliseconds;
}
export function encodeTransactionCursor(
  filter: TransactionFilter,
  position: TransactionCursorPosition,
) {
  return encodeCursor('t2', filterScope(filter), position);
}
export function decodeTransactionCursor(
  cursor: string,
  filter: TransactionFilter,
): TransactionCursorPosition | undefined {
  return decodeCursor('t2', cursor, filterScope(filter), validPosition, 1024);
}
