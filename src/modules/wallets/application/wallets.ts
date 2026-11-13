import { Wallet } from '../domain/wallet';
import { DomainError } from '../../../shared/domain/errors/domain-error';
import type {
  CreateWalletCommand,
  WalletContext,
  WalletStore,
  LedgerQuery,
} from './wallet-store';

function exactMoney(amount: string) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match || (match[3]?.length ?? 0) > 2)
    throw new Error('Reconciliation returned an invalid decimal amount');
  return `${match[1]}${match[2]}.${(match[3] ?? '').padEnd(2, '0')}`;
}

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
    const stored = exactMoney(result.storedBalance);
    const calculated = exactMoney(result.calculatedBalance);
    const difference = exactMoney(result.difference);
    return {
      walletId: id,
      storedBalance: { amount: stored, currency: result.currency },
      calculatedBalance: { amount: calculated, currency: result.currency },
      difference: { amount: difference, currency: result.currency },
      consistent: difference === '0.00' || difference === '-0.00',
      checkedEntries: result.checkedEntries,
    };
  }
}
