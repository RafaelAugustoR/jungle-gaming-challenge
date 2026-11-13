import { expect, test } from 'bun:test';
import { commandSuite, retryUntil } from '../support/command-fixture';

const integration = process.env.INTEGRATION === '1' ? test : test.skip;
const { state, fixture, send, consumer } = commandSuite();
integration(
  'the inbox schema prevents incomplete commits and changing a completed financial association',
  async () => {
    const a = await fixture(),
      b = await fixture(),
      worker = await consumer();
    await send(a.envelope);
    await worker.runOnce();
    await send(b.envelope);
    await worker.runOnce();
    const [second] = await state.orm.em
      .fork()
      .execute('select transaction_id from messaging.command_inbox where message_id=?', [
        b.envelope.messageId,
      ]);
    await expect(
      state.orm.em
        .fork()
        .execute('update messaging.command_inbox set transaction_id=? where message_id=?', [
          second.transaction_id,
          a.envelope.messageId,
        ]),
    ).rejects.toThrow();
    await expect(
      state.orm.em
        .fork()
        .execute(
          'insert into messaging.command_inbox(consumer_name,message_id,request_hash) values(?,?,?)',
          ['test', crypto.randomUUID(), 'a'.repeat(64)],
        ),
    ).rejects.toThrow('null value in column "transaction_id"');
  },
);

integration(
  'inbox migration is reversible and re-applies NOT NULL completeness constraint',
  async () => {
    await state.database.owner.getMigrator().down({ migrations: ['Migration202611130007'] });
    expect(
      (
        await state.database.owner.em.execute(
          "select to_regclass('messaging.command_inbox') as name",
        )
      )[0].name,
    ).toBeNull();
    await state.database.owner.getMigrator().up();
    await expect(
      state.orm.em
        .fork()
        .execute(
          'insert into messaging.command_inbox(consumer_name,message_id,request_hash) values(?,?,?)',
          ['test', crypto.randomUUID(), 'a'.repeat(64)],
        ),
    ).rejects.toThrow('null value in column "transaction_id"');
  },
);

integration(
  'runtime can only insert complete inbox rows and cannot update their transaction association',
  async () => {
    const [privileges] = await state.orm.em
      .fork()
      .execute(
        `select has_column_privilege(current_user,'messaging.command_inbox','transaction_id','UPDATE') as can_update`,
      );
    expect(privileges.can_update).toBe(false);
  },
);
