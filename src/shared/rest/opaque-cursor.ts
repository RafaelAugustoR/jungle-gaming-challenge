export function encodeCursor<T>(version: string, scope: unknown, position: T): string {
  const payload = Buffer.from(JSON.stringify({ scope, position })).toString('base64url');
  return `${version}.${payload}`;
}

export function decodeCursor<T>(
  version: string,
  raw: string,
  scope: unknown,
  isPosition: (value: unknown) => value is T,
  maxLength = 1024,
): T | undefined {
  const prefix = `${version}.`;
  if (raw.length > maxLength || !raw.startsWith(prefix)) return undefined;
  const payload = raw.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return undefined;
  const decoded = Buffer.from(payload, 'base64url').toString();
  if (Buffer.from(decoded).toString('base64url') !== payload) return undefined;
  try {
    const value: unknown = JSON.parse(decoded);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const envelope = value as Record<string, unknown>;
    if (
      Object.keys(envelope).sort().join(',') !== 'position,scope' ||
      JSON.stringify(envelope.scope) !== JSON.stringify(scope) ||
      !isPosition(envelope.position)
    )
      return undefined;
    return envelope.position;
  } catch {
    return undefined;
  }
}
