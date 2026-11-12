export function isTransientPostgresError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string')
    return false;
  return (
    error.code.startsWith('08') ||
    [
      '57P01',
      '57P03',
      '53300',
      '40001',
      '40P01',
      '55P03',
      '57014',
      'ECONNREFUSED',
      'ETIMEDOUT',
    ].includes(error.code)
  );
}

export function isRetryableTransactionError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    ['40001', '40P01', '55P03', '57014'].includes(error.code),
  );
}
