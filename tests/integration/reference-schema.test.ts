import { expect, test } from 'bun:test';
import { createApplication } from '../../src/bootstrap/application';
import { openDatabase } from '../../src/config/orm';
import { ReprocessReferences } from '../../src/modules/wagering/application/reprocess-references';
import { ReferenceRetryPolicy } from '../../src/modules/wagering/domain/reference-retry';
import { WageringRepository } from '../../src/modules/wagering/infrastructure/persistence/wagering-repository';
import { disposableDatabase } from '../support/database';
import { humanToken, providerToken } from '../support/keycloak';
const integration = process.env.INTEGRATION === '1' ? test : test.skip;

integration(
  'result balance backfills from immutable receipts and downgrade refuses resolved pending outcomes',
  async () => {
    const db = await disposableDatabase(),
      app = await createApplication(db.config),
      runtime = await openDatabase(db.config);
    try {
      await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      const human = await humanToken('demo-operator'),
        provider = await providerToken('a');
      const jsonHeaders = (token: string) => ({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      });
      const created = await fetch(`${base}/wallets`, {
        method: 'POST',
        headers: jsonHeaders(human),
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        }),
      });
      const w = (await created.json()) as any;
      const submit = async (kind: string, external: string, reference?: string) => {
        const response = await fetch(`${base}/wagering/transactions`, {
          method: 'POST',
          headers: { ...jsonHeaders(provider), 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({
            providerId: 'provider-a',
            externalTransactionId: external,
            walletId: w.id,
            playerId: w.playerId,
            kind,
            roundId: 'round',
            gameId: 'game',
            money: { amount: '20.00', currency: 'BRL' },
            ...(reference ? { referenceExternalTransactionId: reference } : {}),
          }),
        });
        return (await response.json()) as any;
      };
      const bet = await submit('BET', crypto.randomUUID());
      await db.owner.getMigrator().down({ migrations: ['Migration202611130005'] });
      await db.owner.getMigrator().up();
      const [backfilled] = await db.owner.em.execute(
        'select result_balance::text balance from wagering.transactions where id=?',
        [bet.transactionId],
      );
      expect(backfilled.balance).toBe('80.00');
      const reference = crypto.randomUUID(),
        pending = await submit('REFUND', crypto.randomUUID(), reference);
      await submit('BET', reference);
      await db.owner.em.execute(
        "update wagering.reference_retries set next_attempt_at=clock_timestamp()-interval '1 second' where transaction_id=?",
        [pending.transactionId],
      );
      const runner = new ReprocessReferences(
        new WageringRepository(runtime, db.config),
        new ReferenceRetryPolicy({ ttlMs: 900000, baseMs: 1000, maxMs: 30000 }),
      );
      expect(await runner.runBatch(50)).toBe(1);
      await expect(
        db.owner.getMigrator().down({ migrations: ['Migration202611130005'] }),
      ).rejects.toThrow('RESOLVED_REFERENCES_EXIST');
      const [resolved] = await db.owner.em.execute(
        'select result_balance::text balance from wagering.transactions where id=?',
        [pending.transactionId],
      );
      expect(resolved.balance).toBe('80.00');
      await expect(
        runtime.em.execute('update wagering.transactions set result_balance=0 where id=?', [
          pending.transactionId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await app.close();
      await runtime.close(true);
      await db.close();
    }
  },
);
