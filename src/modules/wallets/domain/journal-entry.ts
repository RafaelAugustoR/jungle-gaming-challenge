import { Money } from '../../../shared/domain/money';
import { DomainError } from '../../../shared/domain/errors/domain-error';

export interface JournalState {
  id: string;
  walletId: string;
  transactionId: string;
  playerAccountId: string;
  debitAccountId: string;
  creditAccountId: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
}
export type JournalProps = JournalState & { direction: 'CREDIT' | 'DEBIT' };
export class JournalEntry {
  private constructor(private readonly state: Readonly<JournalState>) {
    Object.freeze(this);
  }
  static create(
    input: Omit<JournalState, 'id' | 'amount' | 'currency' | 'balanceBefore' | 'balanceAfter'> & {
      money: Money;
      balanceBefore: Money;
      balanceAfter: Money;
    },
  ): JournalEntry {
    const { money, balanceBefore, balanceAfter, ...props } = input;
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency)
      throw new DomainError('CURRENCY_MISMATCH');
    if (
      money.isZero() ||
      money.isNegative() ||
      props.debitAccountId === props.creditAccountId ||
      ![props.debitAccountId, props.creditAccountId].includes(props.playerAccountId) ||
      !Number.isSafeInteger(props.walletVersion) ||
      props.walletVersion < 1 ||
      balanceBefore.isNegative() ||
      balanceAfter.isNegative()
    )
      throw new DomainError('UNBALANCED_JOURNAL');
    const expected =
      props.creditAccountId === props.playerAccountId
        ? balanceBefore.add(money)
        : balanceBefore.subtract(money);
    if (expected.toProps().amount !== balanceAfter.toProps().amount)
      throw new DomainError('UNBALANCED_JOURNAL');
    return new JournalEntry(
      Object.freeze({
        ...props,
        id: crypto.randomUUID(),
        amount: money.toProps().amount,
        currency: money.currency,
        balanceBefore: balanceBefore.toProps().amount,
        balanceAfter: balanceAfter.toProps().amount,
      }),
    );
  }
  static rehydrate(state: JournalState): JournalEntry {
    return new JournalEntry(Object.freeze({ ...state }));
  }
  get direction(): 'CREDIT' | 'DEBIT' {
    return this.state.creditAccountId === this.state.playerAccountId ? 'CREDIT' : 'DEBIT';
  }
  toProps(): JournalProps {
    return { ...this.state, direction: this.direction };
  }
}
