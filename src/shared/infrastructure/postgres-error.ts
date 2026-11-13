const transientCodes = new Set([
  '57P01',
  '57P03',
  '53300',
  '40001',
  '40P01',
  '55P03',
  '57014',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);
const retryableCodes = new Set(['40001', '40P01', '55P03', '57014']);
function field(error: unknown, key: 'code' | 'constraint'): string | undefined {
  if (!error || typeof error !== 'object' || !(key in error)) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
export function pgCode(error: unknown): string | undefined {
  return field(error, 'code');
}
export function pgConstraint(error: unknown): string | undefined {
  return field(error, 'constraint');
}
export function isTransientPostgresError(error: unknown): boolean {
  const code = pgCode(error);
  return code !== undefined && (code.startsWith('08') || transientCodes.has(code));
}
export function isRetryableTransactionError(error: unknown): boolean {
  return retryableCodes.has(pgCode(error) ?? '');
}
