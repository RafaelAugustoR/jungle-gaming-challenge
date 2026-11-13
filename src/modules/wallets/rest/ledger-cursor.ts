import { decodeCursor, encodeCursor } from '../../../shared/rest/opaque-cursor';

export interface LedgerCursorPosition {
  after: number;
  upper: number;
}

export function encodeLedgerCursor(walletId: string, position: LedgerCursorPosition) {
  return encodeCursor('v2', walletId, position);
}

export function decodeLedgerCursor(
  cursor: string,
  walletId: string,
): LedgerCursorPosition | undefined {
  return decodeCursor(
    'v2',
    cursor,
    walletId,
    (value): value is LedgerCursorPosition =>
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === 'after,upper' &&
      Number.isSafeInteger((value as LedgerCursorPosition).after) &&
      Number.isSafeInteger((value as LedgerCursorPosition).upper) &&
      (value as LedgerCursorPosition).after >= 0 &&
      (value as LedgerCursorPosition).after < (value as LedgerCursorPosition).upper,
    256,
  );
}
