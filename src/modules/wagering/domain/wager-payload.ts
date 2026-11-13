import { DomainError } from '../../../shared/domain/errors/domain-error';
import { wagerPayloadHash, type WagerCommand } from './wager-command';
import { wagerStepFor } from './wager-step';
export class WagerPayload {
  private constructor(
    private readonly state: Readonly<{ command: Readonly<WagerCommand>; hash: string }>,
  ) {
    Object.freeze(this);
  }
  static create(input: WagerCommand): WagerPayload {
    const command = Object.freeze({ ...input });
    if (
      ![
        command.providerId,
        command.externalTransactionId,
        command.playerId,
        command.walletId,
        command.roundId,
        command.gameId,
      ].every(
        (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 128,
      ) ||
      command.money.isNegative()
    )
      throw new DomainError('INVALID_PAYLOAD');
    wagerStepFor(command.kind).validate(command);
    return new WagerPayload(Object.freeze({ command, hash: wagerPayloadHash(command) }));
  }
  get command(): Readonly<WagerCommand> {
    return this.state.command;
  }
  get hash(): string {
    return this.state.hash;
  }
}
