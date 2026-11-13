import { Body, Controller, HttpException, Inject, Module, Post, Req, UseGuards } from '@nestjs/common';
import { APP_CONFIG } from '../../config/infrastructure.module';
import type { AppConfig } from '../../config/config';
import { HumanRole, Identity, IdentityModule, type Principal } from '../identity/identity.module';
import { Money } from '../../shared/domain/money';
import { apiError } from '../../shared/rest/api-error';
import { parseUuid } from '../../shared/rest/parse-uuid';
import { WalletsModule } from '../wallets/rest/wallets.module';
import { Wallets } from '../wallets/application/wallets';
import type { WagerKind } from '../wagering/domain/wager-command';
import type { DemoCommand, DemoScenario, DemoSubmission } from './demo-contract';
import { DemoProviderClient } from './infrastructure/demo-provider-client';
import { ScenarioAudit } from './infrastructure/scenario-audit';

interface ScenarioInput {
  scenario: DemoScenario;
  walletId: string;
  amount: string;
}
interface RequestContext {
  principal: Principal;
  socket: { localPort: number };
}
interface ScenarioStep {
  kind: WagerKind;
  externalTransactionId: string;
  idempotencyKey: string;
  referenceExternalTransactionId?: string;
}

function scenarioPlan(scenario: DemoScenario, auditId: string) {
  const id = (suffix: string) => `demo-${auditId}-${suffix}`;
  const step = (
    kind: WagerKind,
    suffix: string,
    key: string,
    referenceExternalTransactionId?: string,
  ): ScenarioStep => ({
    kind,
    externalTransactionId: id(suffix),
    idempotencyKey: id(key),
    ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
  });
  if (scenario === 'duplicate') {
    const bet = step('BET', 'bet', 'key');
    return { concurrent: true, steps: [bet, bet] };
  }
  if (scenario === 'race')
    return {
      concurrent: true,
      steps: [step('BET', 'race-a', 'key-a'), step('BET', 'race-b', 'key-b')],
    };
  return {
    concurrent: false,
    steps: [
      step('REFUND', 'refund', 'refund-key', id('source')),
      step('BET', 'source', 'source-key'),
    ],
  };
}

function input(value: unknown): ScenarioInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw apiError(400, 'INVALID_PAYLOAD');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['scenario', 'walletId', 'amount'].includes(key)))
    throw apiError(400, 'INVALID_PAYLOAD');
  if (!['duplicate', 'race', 'out-of-order'].includes(String(body.scenario)))
    throw apiError(400, 'INVALID_PAYLOAD');
  const amount = body.amount ?? '20.00';
  if (typeof amount !== 'string') throw apiError(400, 'INVALID_PAYLOAD');
  if (typeof body.walletId !== 'string') throw apiError(400, 'INVALID_PAYLOAD');
  return {
    scenario: body.scenario as DemoScenario,
    walletId: parseUuid(body.walletId),
    amount,
  };
}

function disputeAmount(balance: string) {
  const balanceMinor = BigInt(balance.replace('.', ''));
  if (balanceMinor === 0n) throw apiError(422, 'RACE_REQUIRES_POSITIVE_BALANCE');
  const fourFifths = (balanceMinor * 4n) / 5n;
  const greaterThanHalf = balanceMinor / 2n + 1n;
  const amountMinor = fourFifths > greaterThanHalf ? fourFifths : greaterThanHalf;
  const whole = amountMinor / 100n;
  const fraction = (amountMinor % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

function failureCode(error: unknown) {
  if (!(error instanceof HttpException)) return 'INFRASTRUCTURE_UNAVAILABLE';
  const body = error.getResponse();
  return body && typeof body === 'object' && 'code' in body && typeof body.code === 'string'
    ? body.code
    : 'INFRASTRUCTURE_UNAVAILABLE';
}

@Controller('demo')
@UseGuards(Identity)
class DemoController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Wallets) private readonly wallets: Wallets,
    @Inject(DemoProviderClient) private readonly provider: DemoProviderClient,
    @Inject(ScenarioAudit) private readonly audit: ScenarioAudit,
  ) {}

  @Post('scenarios')
  @HumanRole('demo-operator')
  async run(@Body() body: unknown, @Req() request: RequestContext) {
    const selected = input(body);
    const wallet = await this.wallets.get(selected.walletId);
    const amount = Money.create(selected.amount, wallet.balance.currency);
    const provider = this.config.demoProvider;
    if (!provider) throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
    const operationAmount =
      selected.scenario === 'race'
        ? Money.create(disputeAmount(wallet.balance.toProps().amount), wallet.balance.currency).toProps()
        : amount.toProps();
    const auditId = crypto.randomUUID();
    const plan = scenarioPlan(selected.scenario, auditId);
    const externalTransactionIds = [...new Set(
      plan.steps.map(({ externalTransactionId }) => externalTransactionId),
    )];
    const started = new Date().toISOString();
    let submissions: DemoSubmission[] = [];
    await this.audit.start({
      id: auditId,
      actorId: request.principal.subject,
      providerId: provider.providerId,
      scenario: selected.scenario,
      walletId: wallet.id,
      externalTransactionIds,
      started,
    });
    try {
      const token = await this.provider.accessToken(provider);
      const command = ({
        kind, externalTransactionId, referenceExternalTransactionId,
      }: ScenarioStep): DemoCommand => ({
        providerId: provider.providerId,
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: `demo-${auditId}`,
        gameId: 'jungle-demo',
        kind,
        money: operationAmount,
        ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
      });
      const submit = (step: ScenarioStep) =>
        this.provider.submit(request.socket.localPort, token, command(step), step.idempotencyKey);

      if (plan.concurrent) {
        const outcome = await this.submitConcurrent(plan.steps.map(submit));
        submissions = outcome.submissions;
        if (outcome.failed) throw outcome.error;
      } else {
        for (const step of plan.steps) submissions.push(await submit(step));
      }
      await this.audit.finish(auditId, started, 'SUBMITTED', submissions);
      return {
        auditId,
        scenario: selected.scenario,
        providerId: provider.providerId,
        amount: operationAmount,
        transactions: submissions,
      };
    } catch (error) {
      try {
        await this.audit.finish(
          auditId,
          started,
          'FAILED',
          submissions,
          failureCode(error),
        );
      } catch {
        // Keep the original failure; the audit intent still links the external transaction IDs.
      }
      if (error instanceof HttpException) throw error;
      throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
    }
  }

  private async submitConcurrent(operations: Array<Promise<DemoSubmission>>) {
    const settled = await Promise.allSettled(operations);
    const submissions = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const failed = settled.find((result) => result.status === 'rejected');
    return {
      submissions,
      failed: failed?.status === 'rejected',
      ...(failed?.status === 'rejected' ? { error: failed.reason } : {}),
    };
  }
}

@Module({
  imports: [IdentityModule, WalletsModule],
  controllers: [DemoController],
  providers: [DemoProviderClient, ScenarioAudit],
})
export class DemoModule {}
