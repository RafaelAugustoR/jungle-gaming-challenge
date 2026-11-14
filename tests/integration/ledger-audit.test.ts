import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import { disposableDatabase } from '../support/database';
import { ledgerAudit } from '../support/ledger-audit';
import { appendEvent, insertExternalTransaction } from '../support/transaction-fixture';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { PostgresWalletSession } from '../../src/modules/wallets/infrastructure/persistence/opening-session';
import { Money } from '../../src/shared/domain/money';
import { parseIntegrationEvent } from '../../src/messaging/events/integration-envelope';

const integration = process.env.INTEGRATION === '1' ? test : test.skip;
let database: Awaited<ReturnType<typeof disposableDatabase>>;
beforeAll(async () => {
  if (process.env.INTEGRATION === '1') database = await disposableDatabase();
});
afterAll(async () => {
  await database?.close();
});

const audit = () =>
  ledgerAudit((query, params) => database.owner.em.fork().execute(query, params ?? []));

/** Opens a wallet through the production persistence path (OPENING when balance > 0). */
async function open(em: EntityManager, amount: string) {
  const session = new PostgresWalletSession(em);
  const result = Wallet.open({
    playerId: crypto.randomUUID(),
    initialBalance: Money.create(amount, 'BRL'),
    accountId: crypto.randomUUID(),
    ...(await session.openingResources('BRL')),
    context: { correlationId: crypto.randomUUID() },
  });
  await session.saveOpening(result, { actorId: 'ledger-audit-test', correlationId: 'audit' });
  return result.wallet;
}

integration(
  'auditor accepts OPENING, LOSS, zero and rejected operations with exactly their event sets',
  async () => {
    await database.owner.em.fork().transactional(async (em) => {
      await open(em, '100.00');
      const wallet = await open(em, '0.00');
      for (const [kind, amount, status] of [
        ['LOSS', '30.00', 'PROCESSED'],
        ['WIN', '0.00', 'PROCESSED'],
        ['BET', '50.00', 'REJECTED'],
      ] as const)
        await insertExternalTransaction(em, {
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind,
          amount,
          status,
          failureCode: status === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : null,
        });
    });
    expect(await audit()).toEqual({
      invalid_pairs: 0,
      partial_financial_effects: 0,
      missing_receipts: 0,
      pending_transactions: 0,
      invalid_event_sets: 0,
    });
  },
);

integration(
  'auditor flags a balance event without movement and a result event that is missing',
  async () => {
    // The schema refuses both shapes, so the triggers are disabled to plant them: the auditor
    // is an independent oracle and must not rely on those triggers to be right.
    await database.owner.em.fork().transactional(async (em) => {
      const wallet = await open(em, '0.00');
      await em.execute('alter table wagering.outbox disable trigger outbox_consistency');
      await em.execute(
        'alter table wagering.transactions disable trigger external_submission_consistency',
      );
      const loss = await insertExternalTransaction(em, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'LOSS',
        amount: '1.00',
      });
      await appendEvent(em, wallet.id, loss, 'WalletBalanceChanged');
      await insertExternalTransaction(em, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'WIN',
        amount: '0.00',
        resultEvent: false,
      });
      await em.execute('set constraints all immediate');
      await em.execute(
        'alter table wagering.transactions enable trigger external_submission_consistency',
      );
      await em.execute('alter table wagering.outbox enable trigger outbox_consistency');
    });
    expect((await audit()).invalid_event_sets).toBe(2);
  },
);

integration(
  'upgrading to 0011 backfills a parseable processed event for openings committed before it',
  async () => {
    const fixture = await disposableDatabase();
    try {
      await fixture.owner.getMigrator().down({ to: 'Migration202611140010' });
      // Opening as persisted before 0011: OPENING, journal and only WalletBalanceChanged.
      // Before 0011 nothing requires the processed event, so dropping it reproduces that state.
      const opened = await fixture.owner.em.fork().transactional((em) => open(em, '42.50'));
      const wallet = await fixture.owner.em.fork().transactional(async (em) => {
        const wallet = opened;
        await em.execute('alter table wagering.outbox disable trigger outbox_no_delete');
        await em.execute(
          "delete from wagering.outbox where aggregate_id=? and event_type='WagerTransactionProcessed'",
          [wallet.id],
        );
        await em.execute('alter table wagering.outbox enable trigger outbox_no_delete');
        return wallet;
      });
      await fixture.owner.getMigrator().up();
      const rows = await fixture.owner.em.execute<
        { event_type: string; sequence: number; payload: Record<string, unknown> }[]
      >(
        'select event_type,sequence,payload from wagering.outbox where aggregate_id=? order by sequence',
        [wallet.id],
      );
      expect(rows.map((row) => [row.event_type, row.sequence])).toEqual([
        ['WalletBalanceChanged', 1],
        ['WagerTransactionProcessed', 2],
      ]);
      const parsed = parseIntegrationEvent(JSON.stringify({ ...rows[1]!.payload, sequence: 2 }));
      expect(parsed).toMatchObject({
        eventType: 'WagerTransactionProcessed',
        aggregateId: wallet.id,
        correlationId: rows[0]!.payload.correlationId,
        data: {
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: 'OPENING',
          money: { amount: '42.50', currency: 'BRL' },
          balance: { amount: '42.50', currency: 'BRL' },
        },
      });
      expect(
        (await ledgerAudit((query, params) => fixture.owner.em.fork().execute(query, params ?? [])))
          .invalid_event_sets,
      ).toBe(0);
    } finally {
      await fixture.close();
    }
  },
);
