import { isUuid } from '../../../shared/domain/is-uuid';
import type { TransactionFilter, TransactionCursorPosition } from '../application/wagering-store';

const prefix = 't1.';
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
function filterKey(filter: Pick<TransactionFilter, 'walletId' | 'status' | 'kind' | 'providerId'>) {
  return JSON.stringify({
    walletId: filter.walletId ?? null,
    status: filter.status ?? null,
    kind: filter.kind ?? null,
    providerId: filter.providerId ?? null,
  });
}
function validPosition(value: unknown): value is TransactionCursorPosition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const position = value as Record<string, unknown>;
  const validTimestamp = (candidate: unknown) => {
    if (typeof candidate !== 'string' || !timestamp.test(candidate)) return false;
    const milliseconds = `${candidate.slice(0, 23)}Z`;
    const instant = new Date(milliseconds);
    return Number.isFinite(instant.getTime()) && instant.toISOString() === milliseconds;
  };
  return (
    Object.keys(position).sort().join(',') === 'afterCreatedAt,afterId,upperCreatedAt,upperId' &&
    validTimestamp(position.upperCreatedAt) &&
    validTimestamp(position.afterCreatedAt) &&
    isUuid(position.upperId) && isUuid(position.afterId) &&
    (position.afterCreatedAt as string) <= (position.upperCreatedAt as string)
  );
}
export function encodeTransactionCursor(
  filter: Pick<TransactionFilter, 'walletId' | 'status' | 'kind' | 'providerId'>,
  position: TransactionCursorPosition,
) {
  return `${prefix}${Buffer.from(JSON.stringify({ filters: JSON.parse(filterKey(filter)), position })).toString('base64url')}`;
}
export function decodeTransactionCursor(
  cursor: string,
  filter: Pick<TransactionFilter, 'walletId' | 'status' | 'kind' | 'providerId'>,
): TransactionCursorPosition | undefined {
  if (cursor.length > 1024 || !cursor.startsWith(prefix)) return undefined;
  const payload = cursor.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return undefined;
  const decoded = Buffer.from(payload, 'base64url').toString();
  if (Buffer.from(decoded).toString('base64url') !== payload) return undefined;
  try {
    const value: unknown = JSON.parse(decoded);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'filters,position' ||
      JSON.stringify(record.filters) !== filterKey(filter) ||
      !validPosition(record.position)
    ) return undefined;
    return record.position;
  } catch {
    return undefined;
  }
}
