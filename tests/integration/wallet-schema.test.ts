import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openDatabase } from '../../src/config/orm';
import { loadMigrationConfig } from '../../src/config/config';
import type { MikroORM } from '@mikro-orm/postgresql';
const integration = process.env.INTEGRATION === '1' ? test : test.skip;
let orm: MikroORM;
let admin: MikroORM;
let name: string;
beforeAll(async () => {
  if (process.env.INTEGRATION !== '1') return;
  const config = loadMigrationConfig();
  admin = await openDatabase(config);
  name = `wallet_test_${crypto.randomUUID().replaceAll('-', '')}`;
  await admin.em.getConnection().execute(`create database ${name}`);
  const url = new URL(config.databaseUrl);
  url.pathname = `/${name}`;
  orm = await openDatabase({ ...config, databaseUrl: url.toString() });
  await orm.getMigrator().up();
});
afterAll(async () => {
  await orm?.close(true);
  if (admin) {
    await admin.em.getConnection().execute(`drop database ${name}`);
    await admin.close(true);
  }
});

integration('schema rejects positive wallet without its opening journal at commit', async () => {
  await expect(
    orm.em.fork().transactional(async (em) => {
      const id = crypto.randomUUID();
      await em.execute(
        `insert into wagering.accounts(id, currency, kind) values (?, 'BRL', 'PLAYER')`,
        [id],
      );
      await em.execute(
        `insert into wagering.wallets(id, player_id, currency, balance, version, account_id) values (?, ?, 'BRL', 100, 1, ?)`,
        [crypto.randomUUID(), crypto.randomUUID(), id],
      );
    }),
  ).rejects.toThrow();
  // Existence checked separately so a missing table cannot satisfy the invariant test.
  expect((await orm.em.execute('select * from wagering.wallets')).length).toBe(0);
});

import type { EntityManager } from '@mikro-orm/postgresql';
async function opening(em: EntityManager, walletId: string, fault?: string) {
  const player = crypto.randomUUID(),
    account = crypto.randomUUID(),
    counterpart = crypto.randomUUID(),
    transaction = crypto.randomUUID(),
    event = crypto.randomUUID();
  const checkpoint = async (step: string) => {
    if (step === fault) await em.execute('select 1/0');
  };
  await em.execute(
    `insert into wagering.accounts(id, currency, kind) values (?, 'BRL', 'PLAYER')`,
    [account],
  );
  await checkpoint('account');
  await em.execute(
    `insert into wagering.wallets(id, player_id, currency, balance, version, account_id) values (?, ?, 'BRL', 100.00, 1, ?)`,
    [walletId, player, account],
  );
  await checkpoint('wallet');
  await em.execute(
    `insert into wagering.accounts(id, currency, kind) values (?, 'BRL', 'OPENING') on conflict (currency, kind) where kind <> 'PLAYER' do nothing`,
    [counterpart],
  );
  const [counter] = await em.execute<{ id: string }[]>(
    `select id from wagering.accounts where currency = 'BRL' and kind = 'OPENING'`,
  );
  await em.execute(
    `insert into wagering.transactions(id, wallet_id, currency, amount, kind, status) values (?, ?, 'BRL', 100.00, 'OPENING', 'PROCESSED')`,
    [transaction, walletId],
  );
  await checkpoint('opening');
  await em.execute(
    `insert into wagering.journal(id, transaction_id, wallet_id, currency, amount, debit_account_id, credit_account_id, balance_before, balance_after, wallet_version) values (?, ?, ?, 'BRL', 100.00, ?, ?, 0.00, 100.00, 1)`,
    [crypto.randomUUID(), transaction, walletId, counter!.id, account],
  );
  await checkpoint('journal');
  if (fault === 'missing-outbox') return;
  await em.execute(
    `insert into wagering.outbox(event_id, aggregate_id, transaction_id, sequence, event_type, payload) values (?, ?, ?, 1, 'WalletBalanceChanged', ?::jsonb)`,
    [
      event,
      walletId,
      transaction,
      JSON.stringify({
        eventId: event,
        aggregateId: walletId,
        eventType: 'WalletBalanceChanged',
        version: 1,
        data: {
          walletId,
          transactionId: transaction,
          direction: 'CREDIT',
          walletVersion: 1,
          balanceAfter: { amount: '100.00', currency: 'BRL' },
        },
      }),
    ],
  );
  await checkpoint('outbox');
  if (fault === 'missing-processed-event') return;
  await em.execute(
    `insert into wagering.outbox(event_id, aggregate_id, transaction_id, sequence, event_type, payload) values (?, ?, ?, 2, 'WagerTransactionProcessed', '{}'::jsonb)`,
    [crypto.randomUUID(), walletId, transaction],
  );
}
integration(
  'opening, journal, wallet and applicable outbox roll back together at every write boundary',
  async () => {
    for (const step of [
      'account',
      'wallet',
      'opening',
      'journal',
      'outbox',
      'missing-outbox',
      'missing-processed-event',
    ]) {
      const id = crypto.randomUUID();
      await expect(orm.em.fork().transactional((em) => opening(em, id, step))).rejects.toThrow();
      for (const [table, field] of [
        ['wallets', 'id'],
        ['transactions', 'wallet_id'],
        ['journal', 'wallet_id'],
        ['outbox', 'aggregate_id'],
      ]) {
        expect(
          await orm.em.execute(`select * from wagering.${table} where ${field} = ?`, [id]),
        ).toHaveLength(0);
      }
    }
  },
);
integration(
  'SQL rejects invalid numeric values without coercion, duplicated wallets and wrong account currencies',
  async () => {
    for (const amount of [
      '0.001',
      'NaN',
      'Infinity',
      '-Infinity',
      '-0.01',
      '10000000000000000.00',
    ]) {
      await expect(
        orm.em.execute('select ?::wagering.money_amount', [amount]),
      ).rejects.toMatchObject({ code: '23514' });
    }
    const account = crypto.randomUUID(),
      player = crypto.randomUUID();
    await orm.em.execute(
      `insert into wagering.accounts(id, currency, kind) values (?, 'BRL', 'PLAYER')`,
      [account],
    );
    await orm.em.execute(
      `insert into wagering.wallets(id, player_id, currency, balance, version, account_id) values (?, ?, 'BRL', 0.00, 1, ?)`,
      [crypto.randomUUID(), player, account],
    );
    await expect(
      orm.em.fork().transactional(async (em) => {
        const next = crypto.randomUUID();
        await em.execute(
          `insert into wagering.accounts(id, currency, kind) values (?, 'BRL', 'PLAYER')`,
          [next],
        );
        await em.execute(
          `insert into wagering.wallets(id, player_id, currency, balance, version, account_id) values (?, ?, 'BRL', 0.00, 1, ?)`,
          [crypto.randomUUID(), player, next],
        );
      }),
    ).rejects.toMatchObject({ code: '23505' });
    const wrongCurrencyAccount = crypto.randomUUID();
    await orm.em.execute(
      `insert into wagering.accounts(id, currency, kind) values (?, 'BRL', 'PLAYER')`,
      [wrongCurrencyAccount],
    );
    await expect(
      orm.em.execute(
        `insert into wagering.wallets(id, player_id, currency, balance, version, account_id) values (?, ?, 'USD', 0.00, 1, ?)`,
        [crypto.randomUUID(), crypto.randomUUID(), wrongCurrencyAccount],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  },
);
integration(
  'balanced opening is immutable and runtime is neither owner nor privileged',
  async () => {
    const id = crypto.randomUUID();
    await orm.em.fork().transactional((em) => opening(em, id));
    const [summary] = await orm.em.execute(
      `select w.balance::text, w.version, (select sum(case when credit_account_id = w.account_id then amount else -amount end) from wagering.journal where wallet_id = w.id)::text as reconstructed, (select count(*)::int from wagering.outbox where aggregate_id = w.id) as events from wagering.wallets w where id = ?`,
      [id],
    );
    expect(summary).toEqual({ balance: '100.00', version: 1, reconstructed: '100.00', events: 2 });
    for (const statement of [
      'update wagering.journal set amount = amount',
      'delete from wagering.journal',
      'truncate wagering.journal',
    ]) {
      await expect(orm.em.execute(statement)).rejects.toMatchObject({ code: '23514' });
      await expect(
        orm.em.fork().transactional(async (em) => {
          await em.execute('set local role jungle_runtime');
          await em.execute(statement);
        }),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await orm.em.fork().transactional(async (em) => {
      await em.execute('set local role jungle_runtime');
      const [role] = await em.execute(
        `select rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = current_user`,
      );
      expect(role).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
      const [owner] = await em.execute(
        `select tableowner = current_user as owns from pg_tables where schemaname = 'wagering' and tablename = 'journal'`,
      );
      expect(owner.owns).toBe(false);
    });
    await expect(
      orm.em.fork().transactional(async (em) => {
        await em.execute('set local role jungle_runtime');
        await em.execute('alter table wagering.journal disable trigger all');
      }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      orm.em.execute('update wagering.wallets set balance = 101.00 where id = ?', [id]),
    ).rejects.toMatchObject({ code: '23514' });
  },
);
