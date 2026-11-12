import { Money } from '../../../shared/domain/money';
export interface JournalProps {
  id: string;
  walletId: string;
  transactionId: string;
  debitAccountId: string;
  creditAccountId: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  direction: 'CREDIT' | 'DEBIT';
  walletVersion: number;
}
export class JournalEntry {
  private constructor(private readonly state: Readonly<JournalProps>) {
    Object.freeze(this);
  }
  static create(
    input: Omit<JournalProps, 'id' | 'amount' | 'currency' | 'balanceBefore' | 'balanceAfter'> & {
      money: Money;
      balanceBefore: Money;
      balanceAfter: Money;
    },
  ): JournalEntry {
    const { money, balanceBefore, balanceAfter, ...props } = input;
    return JournalEntry.rehydrate({
      ...props,
      id: crypto.randomUUID(),
      amount: money.toProps().amount,
      currency: money.currency,
      balanceBefore: JournalEntry.sameCurrency(money, balanceBefore).toProps().amount,
      balanceAfter: JournalEntry.sameCurrency(money, balanceAfter).toProps().amount,
    });
  }
  private static sameCurrency(money: Money, other: Money) {
    if (money.currency !== other.currency) throw new Error('CURRENCY_MISMATCH');
    return other;
  }
  static rehydrate(props: JournalProps): JournalEntry {
    const money = Money.create(props.amount, props.currency);
    const before = Money.create(props.balanceBefore, props.currency);
    const after = Money.create(props.balanceAfter, props.currency);
    const expected = props.direction === 'CREDIT' ? before.add(money) : before.subtract(money);
    if (
      money.isZero() ||
      !['CREDIT', 'DEBIT'].includes(props.direction) ||
      props.debitAccountId === props.creditAccountId ||
      expected.toProps().amount !== after.toProps().amount ||
      !Number.isSafeInteger(props.walletVersion) ||
      props.walletVersion < 1
    )
      throw new Error('UNBALANCED_JOURNAL');
    return new JournalEntry(Object.freeze({ ...props }));
  }
  toProps(): JournalProps {
    return { ...this.state };
  }
}
