export type DomainErrorCategory =
  | 'invalid'
  | 'rejected'
  | 'forbidden'
  | 'conflict'
  | 'notFound'
  | 'unavailable'
  | 'internal';
export const domainErrorCategories = {
  INVALID_PAYLOAD: 'invalid',
  INSUFFICIENT_FUNDS: 'rejected',
  INVALID_TRANSACTION_TRANSITION: 'internal',
  PLAYER_MISMATCH: 'invalid',
  UNKNOWN_PROVIDER: 'forbidden',
  IDEMPOTENCY_CONFLICT: 'conflict',
  EXTERNAL_TRANSACTION_CONFLICT: 'conflict',
  TRANSACTION_NOT_FOUND: 'notFound',
  AMOUNT_LIMIT_EXCEEDED: 'invalid',
  CURRENCY_MISMATCH: 'invalid',
  UNBALANCED_JOURNAL: 'internal',
  WALLET_ALREADY_EXISTS: 'conflict',
  WALLET_NOT_FOUND: 'notFound',
  INFRASTRUCTURE_UNAVAILABLE: 'unavailable',
} as const satisfies Record<string, DomainErrorCategory>;
export type DomainErrorCode = keyof typeof domainErrorCategories;
export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode) {
    super(code);
    this.name = 'DomainError';
  }
  get category(): DomainErrorCategory {
    return domainErrorCategories[this.code];
  }
}
