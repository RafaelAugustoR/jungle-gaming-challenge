export interface LedgerCursorPosition {
  after: number;
  upper: number;
}

const versionPrefix = 'v1.';

export function encodeLedgerCursor(walletId: string, position: LedgerCursorPosition) {
  const payload = Buffer.from(JSON.stringify({ walletId, ...position })).toString('base64url');
  return `${versionPrefix}${payload}`;
}

export function decodeLedgerCursor(
  cursor: string,
  walletId: string,
): LedgerCursorPosition | undefined {
  if (cursor.length > 256 || !cursor.startsWith(versionPrefix)) return undefined;
  const payload = cursor.slice(versionPrefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return undefined;
  const decoded = Buffer.from(payload, 'base64url').toString();
  if (Buffer.from(decoded).toString('base64url') !== payload) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !== 'after,upper,walletId' ||
    value.walletId !== walletId ||
    !Number.isSafeInteger(value.after) ||
    !Number.isSafeInteger(value.upper) ||
    (value.after as number) < 0 ||
    (value.after as number) >= (value.upper as number)
  )
    return undefined;
  return { after: value.after as number, upper: value.upper as number };
}
