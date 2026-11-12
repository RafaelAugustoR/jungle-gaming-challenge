import { Money } from '../../../shared/domain/money';

export interface WalletProps {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
}
export class Wallet {
  private constructor(private readonly state: Readonly<WalletProps>) {
    Object.freeze(this);
  }
  static create(playerId: string, balance: Money): Wallet {
    return Wallet.rehydrate({
      id: crypto.randomUUID(),
      playerId,
      balance: balance.toProps().amount,
      currency: balance.currency,
      version: 1,
    });
  }
  static rehydrate(props: WalletProps): Wallet {
    Money.rehydrate({ amount: props.balance, currency: props.currency });
    if (
      !props.playerId.trim() ||
      props.playerId.length > 128 ||
      !Number.isSafeInteger(props.version) ||
      props.version < 1 ||
      !/^[0-9a-f-]{36}$/.test(props.id)
    )
      throw new Error('INVALID_PAYLOAD');
    return new Wallet(Object.freeze({ ...props }));
  }
  toProps(): WalletProps {
    return { ...this.state };
  }
}
