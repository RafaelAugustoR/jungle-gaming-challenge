import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { Principal } from '../../identity/principal';
import type { TransactionView, WageringStore } from './wagering-store';
export class WagerQueries {
  constructor(private readonly store: WageringStore) {}
  private owned(view: TransactionView | undefined, principal: Principal): TransactionView {
    if (!view || (principal.kind === 'provider' && view.providerId !== principal.providerId))
      throw new DomainError('TRANSACTION_NOT_FOUND');
    return view;
  }
  async get(id: string, principal: Principal): Promise<TransactionView> {
    return this.owned(await this.store.find(id), principal);
  }
  async getExternal(
    providerId: string,
    externalId: string,
    principal: Principal,
  ): Promise<TransactionView> {
    return this.owned(await this.store.findExternal(providerId, externalId), principal);
  }
}
