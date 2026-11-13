import { Wallet } from '../domain/wallet';
import { DomainError } from '../../../shared/domain/errors/domain-error';
import { Money } from '../../../shared/domain/money';
import type {
  CreateWalletCommand,
  WalletContext,
  WalletStore,
  LedgerQuery,
} from './wallet-store';

export class Wallets {
  constructor(private readonly store: WalletStore) {}
  create(command: CreateWalletCommand, context: WalletContext) {
    return this.store.transaction(async (session) => {
      const resources = await session.openingResources(command.initialBalance.currency);
      const result = Wallet.open({
        ...command,
        ...resources,
        accountId: crypto.randomUUID(),
        context,
      });
      await session.saveOpening(result, context);
      return result.wallet;
    });
  }
  async get(id: string) {
    const wallet = await this.store.find(id);
    if (!wallet) throw new DomainError('WALLET_NOT_FOUND');
    return wallet;
  }
  async ledger(id: string, query: LedgerQuery) {
    const wallet = await this.get(id);
    const after = query.cursor?.after ?? 0;
    const upper = query.cursor?.upper ?? wallet.version;
    if (upper > wallet.version) throw new DomainError('INVALID_PAYLOAD');
    const rows = await this.store.ledger(id, after, upper, query.limit + 1);
    const entries = rows.slice(0, query.limit);
    return {
      entries,
      next: rows.length > query.limit ? { after: entries.at(-1)!.walletVersion, upper } : null,
    };
  }
  async reconcile(id: string) {
    const result = await this.store.reconcile(id);
    if (!result) throw new DomainError('WALLET_NOT_FOUND');
    const stored = Money.rehydrate({ amount: result.storedBalance, currency: result.currency });
    const calculated = Money.rehydrate({
      amount: result.calculatedBalance,
      currency: result.currency,
    });
    return {
      walletId: id,
      storedBalance: stored.toProps(),
      calculatedBalance: calculated.toProps(),
      difference: stored.subtract(calculated).toProps(),
      consistent: stored.toProps().amount === calculated.toProps().amount,
      checkedEntries: result.checkedEntries,
    };
  }
}
