import { Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import type { DemoScenario, DemoSubmission } from '../demo-contract';

interface ScenarioAuditStart {
  id: string;
  actorId: string;
  providerId: string;
  scenario: DemoScenario;
  walletId: string;
  externalTransactionIds: string[];
  started: string;
}

@Injectable()
export class ScenarioAudit {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async start(input: ScenarioAuditStart) {
    await this.orm.em
      .fork()
      .execute(
        `insert into demo.scenario_audit(id,actor_id,provider_id,scenario,wallet_id,external_transaction_ids,outcome) values(?,?,?,?,?,?::text[],?::jsonb)`,
        [
          input.id,
          input.actorId,
          input.providerId,
          input.scenario,
          input.walletId,
          `{${input.externalTransactionIds.join(',')}}`,
          JSON.stringify({ started: input.started, state: 'RUNNING' }),
        ],
      );
  }

  async finish(
    id: string,
    started: string,
    state: 'SUBMITTED' | 'FAILED',
    submissions: readonly DemoSubmission[],
    errorCode?: string,
  ) {
    const transactionIds = submissions.map(
      ({ originalReceipt }) => originalReceipt.body.transactionId,
    );
    await this.orm.em
      .fork()
      .execute(
        `update demo.scenario_audit set transaction_ids=?::uuid[],outcome=?::jsonb where id=?`,
        [
          `{${transactionIds.join(',')}}`,
          JSON.stringify({
            started,
            finished: new Date().toISOString(),
            state,
            results: submissions,
            ...(errorCode ? { errorCode } : {}),
          }),
          id,
        ],
      );
  }
}
