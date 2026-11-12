export type DomainErrorCode =
  | 'INVALID_PAYLOAD'
  | 'AMOUNT_LIMIT_EXCEEDED'
  | 'CURRENCY_MISMATCH'
  | 'UNBALANCED_JOURNAL'
  | 'WALLET_ALREADY_EXISTS'
  | 'WALLET_NOT_FOUND'
  | 'INFRASTRUCTURE_UNAVAILABLE';

export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode) {
    super(code);
    this.name = 'DomainError';
  }
}
