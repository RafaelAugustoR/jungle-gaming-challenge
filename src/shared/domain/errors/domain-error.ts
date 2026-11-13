export type DomainErrorCode =
  | 'INBOX_CONFLICT'
  | 'INVALID_PAYLOAD'
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_TRANSACTION_TRANSITION'
  | 'PLAYER_MISMATCH'
  | 'UNKNOWN_PROVIDER'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EXTERNAL_TRANSACTION_CONFLICT'
  | 'TRANSACTION_NOT_FOUND'
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
