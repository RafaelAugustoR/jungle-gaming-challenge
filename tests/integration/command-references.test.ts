import { expect, test } from 'bun:test';
import { commandSuite, retryUntil } from '../support/command-fixture';
import { WageringRepository } from '../../src/modules/wagering/infrastructure/persistence/wagering-repository';
import { Wallets } from '../../src/modules/wallets/application/wallets';
import { WalletRepository } from '../../src/modules/wallets/infrastructure/persistence/wallet-repository';
const integration = process.env.INTEGRATION === '1' ? test : test.skip;
const { state, fixture, send, consumer } = commandSuite();
integration(
  'pending SQS REFUND is acked so its BET can arrive in the same FIFO group, then #6 completes it',
  async () => {
    const { envelope, wallet } = await fixture();
    const refund = {
      ...envelope,
      messageId: crypto.randomUUID(),
      data: {
        ...envelope.data,
        kind: 'REFUND',
        externalTransactionId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        referenceExternalTransactionId: envelope.data.externalTransactionId,
      },
    };
    await send(refund);
    const worker = await consumer();
    await worker.runOnce();
    const pending = await state.orm.em
      .fork()
      .execute('select status from wagering.transactions where external_transaction_id=?', [
        refund.data.externalTransactionId,
      ]);
    expect(pending[0].status).toBe('PENDING_REFERENCE');
    await send(envelope);
    expect(await worker.runOnce()).toBe(1);
    const { ReprocessReferences } =
      await import('../../src/modules/wagering/application/reprocess-references');
    const { WageringRepository } =
      await import('../../src/modules/wagering/infrastructure/persistence/wagering-repository');
    const { ReferenceRetryPolicy } =
      await import('../../src/modules/wagering/domain/reference-retry');
    const reprocess = new ReprocessReferences(
      new WageringRepository(state.orm, state.database.config),
      new ReferenceRetryPolicy({ ttlMs: 900000, baseMs: 1, maxMs: 1 }),
    );
    await retryUntil(
      async () => {
        await reprocess.runBatch(10);
        return (
          await state.orm.em
            .fork()
            .execute('select status from wagering.transactions where external_transaction_id=?', [
              refund.data.externalTransactionId,
            ])
        )[0].status;
      },
      (status) => status === 'PROCESSED',
    );
    expect(
      (
        await new Wallets(new WalletRepository(state.orm), { divergence() {} }).get(wallet.id)
      ).balance.toProps().amount,
    ).toBe('100.00');
    expect(
      (await new Wallets(new WalletRepository(state.orm), { divergence() {} }).reconcile(wallet.id))
        .consistent,
    ).toBe(true);
  },
);
