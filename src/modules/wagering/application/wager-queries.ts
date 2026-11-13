import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { Principal } from '../../identity/principal';
import type { TransactionFilter, TransactionView, WageringStore } from './wagering-store';
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
  async list(filter: TransactionFilter, principal: Principal) {
    const result = await this.store.list(filter);
    const transactions = result.transactions.filter(
      (view) => principal.kind !== 'provider' || view.providerId === principal.providerId,
    );
    return {
      transactions,
      next: result.next,
    };
  }
}
