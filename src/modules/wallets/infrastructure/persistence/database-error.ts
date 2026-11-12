import { DomainError } from '../../../../shared/domain/errors/domain-error';

export async function databaseOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const { code, constraint } = error as { code?: string; constraint?: string };
    if (code === '23505' && constraint === 'wallets_player_id_currency_key')
      throw new DomainError('WALLET_ALREADY_EXISTS');
    if (
      code?.startsWith('08') ||
      ['57P01', '57P03', '53300', '40001', '40P01', '55P03', 'ECONNREFUSED', 'ETIMEDOUT'].includes(
        code ?? '',
      )
    )
      throw new DomainError('INFRASTRUCTURE_UNAVAILABLE');
    throw error;
  }
}
