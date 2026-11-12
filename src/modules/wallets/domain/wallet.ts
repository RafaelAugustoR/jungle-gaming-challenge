import { Money } from '../../../shared/domain/money';
import { DomainError } from '../../../shared/domain/errors/domain-error';
import type { EventContext } from '../../../shared/domain/events/integration-event';
import { JournalEntry } from './journal-entry';
import { WalletBalanceChanged } from './events/wallet-balance-changed';

export interface WalletProps {
  id: string;
  playerId: string;
  accountId: string;
  currency: string;
  balance: string;
  version: number;
}
export interface OpenWallet {
  playerId: string;
  initialBalance: Money;
  accountId: string;
  counterpartAccountId: string;
  occurredAt: string;
  context: EventContext;
}
export interface OpeningTransaction {
  readonly id: string;
  readonly walletId: string;
  readonly currency: string;
  readonly amount: string;
  readonly kind: 'OPENING';
  readonly status: 'PROCESSED';
  readonly createdAt: string;
}
export interface WalletOpening {
  readonly transaction: OpeningTransaction;
  readonly entry: JournalEntry;
  readonly event: WalletBalanceChanged;
}
export interface WalletOpenResult {
  readonly wallet: Wallet;
  readonly opening?: WalletOpening;
}
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly accountId: string,
    readonly balance: Money,
    readonly version: number,
  ) {
    Object.freeze(this);
  }
  static open(input: OpenWallet): WalletOpenResult {
    if (!input.playerId.trim() || input.playerId.length > 128 || input.initialBalance.isNegative())
      throw new DomainError('INVALID_PAYLOAD');
    const wallet = new Wallet(
      crypto.randomUUID(),
      input.playerId,
      input.accountId,
      input.initialBalance,
      1,
    );
    if (wallet.balance.isZero()) return { wallet };
    const transaction = Object.freeze({
      id: crypto.randomUUID(),
      walletId: wallet.id,
      currency: wallet.currency,
      amount: wallet.balance.toProps().amount,
      kind: 'OPENING' as const,
      status: 'PROCESSED' as const,
      createdAt: input.occurredAt,
    });
    const entry = JournalEntry.create({
      walletId: wallet.id,
      transactionId: transaction.id,
      playerAccountId: wallet.accountId,
      debitAccountId: input.counterpartAccountId,
      creditAccountId: wallet.accountId,
      money: wallet.balance,
      balanceBefore: Money.create('0.00', wallet.currency),
      balanceAfter: wallet.balance,
      walletVersion: wallet.version,
    });
    return {
      wallet,
      opening: Object.freeze({
        transaction,
        entry,
        event: WalletBalanceChanged.from(entry, input.occurredAt, input.context),
      }),
    };
  }
  static rehydrate(props: WalletProps): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.accountId,
      Money.rehydrate({ amount: props.balance, currency: props.currency }),
      props.version,
    );
  }
  get currency(): string {
    return this.balance.currency;
  }
  debit(input: { transactionId: string; money: Money; counterpartAccountId: string }): {
    wallet: Wallet;
    entry?: JournalEntry;
  } {
    if (input.money.isNegative()) throw new DomainError('INVALID_PAYLOAD');
    const balance = this.balance.subtract(input.money);
    if (balance.isNegative()) throw new DomainError('INSUFFICIENT_FUNDS');
    if (input.money.isZero()) return { wallet: this };
    const wallet = new Wallet(this.id, this.playerId, this.accountId, balance, this.version + 1);
    const entry = JournalEntry.create({
      walletId: this.id,
      transactionId: input.transactionId,
      playerAccountId: this.accountId,
      debitAccountId: this.accountId,
      creditAccountId: input.counterpartAccountId,
      money: input.money,
      balanceBefore: this.balance,
      balanceAfter: balance,
      walletVersion: wallet.version,
    });
    return { wallet, entry };
  }
  toProps(): WalletProps {
    return {
      id: this.id,
      playerId: this.playerId,
      accountId: this.accountId,
      currency: this.currency,
      balance: this.balance.toProps().amount,
      version: this.version,
    };
  }
}
