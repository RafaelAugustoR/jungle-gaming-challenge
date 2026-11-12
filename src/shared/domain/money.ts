import Decimal from 'decimal.js';

const Exact = Decimal.clone({ precision: 40 });
const MAX = '9999999999999999.99';
export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }
  static create(amount: string, currency: string): Money {
    if (
      typeof amount !== 'string' ||
      !/^(0|[1-9]\d*)\.\d{2}$/.test(amount) ||
      !/^[A-Z]{3}$/.test(currency)
    )
      throw new Error('INVALID_PAYLOAD');
    return Money.exact(new Exact(amount), currency);
  }
  static rehydrate(props: MoneyProps): Money {
    return Money.create(props.amount, props.currency);
  }
  private static exact(value: Decimal, currency: string): Money {
    if (value.abs().gt(MAX)) throw new Error('AMOUNT_LIMIT_EXCEEDED');
    return new Money(value, currency);
  }
  private compatible(other: Money) {
    if (this.currency !== other.currency) throw new Error('CURRENCY_MISMATCH');
  }
  add(other: Money): Money {
    this.compatible(other);
    return Money.exact(this.value.add(other.value), this.currency);
  }
  subtract(other: Money): Money {
    return this.add(other.negate());
  }
  negate(): Money {
    return Money.exact(this.value.negated(), this.currency);
  }
  isZero(): boolean {
    return this.value.isZero();
  }
  isNegative(): boolean {
    return this.value.isNegative() && !this.isZero();
  }
  toProps(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }
}
