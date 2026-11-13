import { Body, Controller, Inject, Module, Post, Req, UseGuards } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG } from '../../config/infrastructure.module';
import type { AppConfig } from '../../config/config';
import { Access, Identity, IdentityModule, type Principal } from '../identity/identity.module';
import { apiError } from '../../shared/rest/api-error';
import { WalletRepository } from '../wallets/infrastructure/persistence/wallet-repository';
import { parseUuid } from '../../shared/rest/parse-uuid';
import { identifier } from '../wagering/application/wager-contract';

type Scenario = 'duplicate' | 'race' | 'out-of-order';
interface RequestContext {
  principal: Principal;
  socket: { localPort: number };
}
interface TransactionResult {
  transactionId: string;
  status: string;
  [key: string]: unknown;
}

function input(value: unknown): { scenario: Scenario; walletId: string; amount: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw apiError(400, 'INVALID_PAYLOAD');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['scenario', 'walletId', 'amount'].includes(key)))
    throw apiError(400, 'INVALID_PAYLOAD');
  if (!['duplicate', 'race', 'out-of-order'].includes(String(body.scenario)))
    throw apiError(400, 'INVALID_PAYLOAD');
  const amount = body.amount ?? '20.00';
  if (typeof amount !== 'string' || !/^(0|[1-9][0-9]{0,15})\.[0-9]{2}$/.test(amount))
    throw apiError(400, 'INVALID_PAYLOAD');
  return {
    scenario: body.scenario as Scenario,
    walletId: parseUuid(identifier(body.walletId)),
    amount,
  };
}

@Controller('demo')
@UseGuards(Identity)
class DemoController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(WalletRepository) private readonly wallets: WalletRepository,
  ) {}

  @Post('scenarios')
  @Access({ humanRoles: ['demo-operator'] })
  async run(@Body() body: unknown, @Req() request: RequestContext) {
    if (request.principal.kind !== 'human') throw apiError(403, 'FORBIDDEN');
    const selected = input(body);
    const wallet = await this.wallets.find(selected.walletId);
    if (!wallet) throw apiError(404, 'WALLET_NOT_FOUND');
    const clientId = Object.keys(this.config.providerClients).find(
      (client) => this.config.demoProviderClientSecrets[this.config.providerClients[client]],
    );
    if (!clientId) throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
    const providerId = this.config.providerClients[clientId]!;
    const secret = this.config.demoProviderClientSecrets[providerId]!;
    const auditId = crypto.randomUUID();
    const externalTransactionIds =
      selected.scenario === 'duplicate'
        ? [`demo-${auditId}-bet`]
        : selected.scenario === 'race'
          ? [`demo-${auditId}-race-a`, `demo-${auditId}-race-b`]
        : [`demo-${auditId}-refund`, `demo-${auditId}-source`];
    const requestBase = `http://127.0.0.1:${request.socket.localPort}`;
    const started = new Date().toISOString();
    let results: unknown[] = [];
    await this.orm.em
      .fork()
      .execute(
        `insert into demo.scenario_audit(id,actor_id,provider_id,scenario,wallet_id,external_transaction_ids,outcome) values(?,?,?,?,?,?::text[],?::jsonb)`,
        [
          auditId,
          request.principal.subject,
          providerId,
          selected.scenario,
          wallet.id,
          `{${externalTransactionIds.join(',')}}`,
          JSON.stringify({ started, state: 'RUNNING' }),
        ],
      );
    try {
      const token = await this.providerToken(clientId, secret);
      const submit = async (command: Record<string, unknown>, key: string) => {
        const response = await fetch(`${requestBase}/wagering/transactions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
          },
          body: JSON.stringify(command),
          signal: AbortSignal.timeout(5000),
        });
        const value = (await response.json()) as TransactionResult;
        if (!value.transactionId || (response.status >= 500 && !response.ok))
          throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
        return { httpStatus: response.status, receipt: value };
      };
      const command = (
        kind: string,
        externalTransactionId: string,
        referenceExternalTransactionId?: string,
      ) => ({
        providerId,
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: `demo-${auditId}`,
        gameId: 'jungle-demo',
        kind,
        money: { amount: selected.amount, currency: wallet.balance.currency },
        ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
      });
      const submitConcurrent = async (operations: Array<Promise<unknown>>) => {
        const settled = await Promise.allSettled(operations);
        results = settled.map((result) =>
          result.status === 'fulfilled' ? result.value : { error: 'DEMO_PROVIDER_UNAVAILABLE' },
        );
        if (settled.some((result) => result.status === 'rejected'))
          throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
      };
      if (selected.scenario === 'duplicate') {
        const externalId = `demo-${auditId}-bet`,
          key = `demo-${auditId}-key`;
        await submitConcurrent([
          submit(command('BET', externalId), key),
          submit(command('BET', externalId), key),
        ]);
      } else if (selected.scenario === 'race') {
        await submitConcurrent([
          submit(command('BET', `demo-${auditId}-race-a`), `demo-${auditId}-key-a`),
          submit(command('BET', `demo-${auditId}-race-b`), `demo-${auditId}-key-b`),
        ]);
      } else {
        const source = `demo-${auditId}-source`;
        const pending = await submit(
          command('REFUND', `demo-${auditId}-refund`, source),
          `demo-${auditId}-refund-key`,
        );
        results = [pending];
        const bet = await submit(command('BET', source), `demo-${auditId}-source-key`);
        results = [pending, bet];
      }
      const transactions = await Promise.all(
        results.map(async (result) => {
          const submitted = result as { httpStatus: number; receipt: TransactionResult };
          let current: unknown;
          const deadline = Date.now() + (selected.scenario === 'out-of-order' ? 12000 : 1500);
          do {
            const response = await fetch(
              `${requestBase}/wagering/transactions/${encodeURIComponent(submitted.receipt.transactionId)}`,
              {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(3000),
              },
            );
            if (!response.ok) throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
            current = await response.json();
            const state = (current as { status?: string }).status;
            if (state !== 'PENDING' && state !== 'PENDING_REFERENCE') break;
            if (Date.now() >= deadline) break;
            await new Promise((resolve) => setTimeout(resolve, 150));
          } while (true);
          return { httpStatus: submitted.httpStatus, originalReceipt: submitted.receipt, current };
        }),
      );
      results = transactions;
      const ids = transactions
        .map((result) => result.originalReceipt.transactionId)
        .filter(Boolean);
      await this.orm.em
        .fork()
        .execute(
          `update demo.scenario_audit set transaction_ids=?::uuid[],outcome=?::jsonb where id=?`,
          [
            `{${ids.join(',')}}`,
            JSON.stringify({
              started,
              finished: new Date().toISOString(),
              state: 'COMPLETED',
              results,
            }),
            auditId,
          ],
        );
      return { auditId, scenario: selected.scenario, providerId, transactions: results };
    } catch (error) {
      const ids = results.flatMap((result) => {
        if (!result || typeof result !== 'object') return [];
        const item = result as { receipt?: TransactionResult; originalReceipt?: TransactionResult };
        const id = item.receipt?.transactionId ?? item.originalReceipt?.transactionId;
        return id ? [id] : [];
      });
      await this.orm.em
        .fork()
        .execute(
          `update demo.scenario_audit set transaction_ids=?::uuid[],outcome=?::jsonb where id=?`,
          [
            `{${ids.join(',')}}`,
            JSON.stringify({
              started,
              finished: new Date().toISOString(),
              state: 'FAILED',
              results,
              error: error instanceof Error ? error.message : 'UNKNOWN',
            }),
            auditId,
          ],
        );
      throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
    }
  }

  private async providerToken(clientId: string, secret: string) {
    const response = await fetch(this.config.keycloakTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: secret,
      }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await response.json()) as { access_token?: string };
    if (!response.ok || !body.access_token) throw new Error('DEMO_PROVIDER_UNAVAILABLE');
    return body.access_token;
  }
}

@Module({
  imports: [IdentityModule],
  controllers: [DemoController],
  providers: [WalletRepository],
})
export class DemoModule {}
