import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import { disposableDatabase } from '../support/database';
import { openDatabase } from '../../src/config/orm';
import {
  appendEvent,
  appendResultEvent,
  insertExternalTransaction,
} from '../support/transaction-fixture';
const integration = process.env.INTEGRATION === '1' ? test : test.skip;
let database: Awaited<ReturnType<typeof disposableDatabase>>;
beforeAll(async () => {
  if (process.env.INTEGRATION === '1') database = await disposableDatabase();
});
afterAll(async () => {
  await database?.close();
});

async function wallet(em: EntityManager) {
  const id = crypto.randomUUID(),
    account = crypto.randomUUID(),
    player = crypto.randomUUID();
  await em.execute(`insert into wagering.accounts(id,currency,kind) values(?,'BRL','PLAYER')`, [
    account,
  ]);
  await em.execute(
    `insert into wagering.wallets(id,player_id,currency,balance,version,account_id) values(?,?,'BRL',0,1,?)`,
    [id, player, account],
  );
  return { id, account, player };
}
async function movement(
  em: EntityManager,
  owner: { id: string; account: string; player: string },
  kind: string,
  before: string,
  after: string,
  version: number,
  omitEvent = false,
  reverseDirection = false,
) {
  const transaction = crypto.randomUUID();
  const debit = (kind === 'BET') !== reverseDirection;
  const amount = kind === 'BET' ? '20.00' : kind === 'OPENING' ? '100.00' : '5.00';
  const [counter] = await em.execute<{ id: string }[]>(
    `select id from wagering.accounts where currency='BRL' and kind=?`,
    [kind === 'OPENING' ? 'OPENING' : 'GAMING'],
  );
  if (kind === 'OPENING') {
    await em.execute(
      `insert into wagering.transactions(id,wallet_id,currency,kind,status,amount) values(?,?,'BRL',?,'PROCESSED',?)`,
      [transaction, owner.id, kind, amount],
    );
    await appendResultEvent(em, owner.id, transaction, 'PROCESSED');
  } else
    await insertExternalTransaction(em, {
      id: transaction,
      walletId: owner.id,
      playerId: owner.player,
      kind,
      amount,
    });
  await em.execute(
    `insert into wagering.journal(id,transaction_id,wallet_id,currency,amount,debit_account_id,credit_account_id,balance_before,balance_after,wallet_version) values(?,?,?,'BRL',?,?,?,?,?,?)`,
    [
      crypto.randomUUID(),
      transaction,
      owner.id,
      amount,
      debit ? owner.account : counter!.id,
      debit ? counter!.id : owner.account,
      before,
      after,
      version,
    ],
  );
  if (!omitEvent) await appendEvent(em, owner.id, transaction, 'WalletBalanceChanged');
  await em.execute(`update wagering.wallets set balance=?,version=? where id=?`, [
    after,
    version,
    owner.id,
  ]);
}
integration(
  'generic journal chain accepts opening, debit and credit with derived ledger direction',
  async () => {
    const owner = await database.owner.em.fork().transactional(async (em) => {
      const owner = await wallet(em);
      await movement(em, owner, 'OPENING', '0.00', '100.00', 1);
      await movement(em, owner, 'BET', '100.00', '80.00', 2);
      await movement(em, owner, 'WIN', '80.00', '85.00', 3);
      return owner;
    });
    expect(
      await database.owner.em.execute(
        `select kind,direction,balance_after::text,wallet_version from wagering.wallet_ledger where wallet_id=? order by wallet_version`,
        [owner.id],
      ),
    ).toEqual([
      { kind: 'OPENING', direction: 'CREDIT', balance_after: '100.00', wallet_version: 1 },
      { kind: 'BET', direction: 'DEBIT', balance_after: '80.00', wallet_version: 2 },
      { kind: 'WIN', direction: 'CREDIT', balance_after: '85.00', wallet_version: 3 },
    ]);
  },
);

integration(
  'chain rejects gaps, wrong arithmetic, missing events and journals without matching wallet update',
  async () => {
    for (const scenario of ['gap', 'arithmetic', 'missing-event', 'wallet-mismatch']) {
      await expect(
        database.owner.em.fork().transactional(async (em) => {
          const owner = await wallet(em);
          await movement(em, owner, 'OPENING', '0.00', '100.00', 1);
          await movement(
            em,
            owner,
            'BET',
            '100.00',
            scenario === 'arithmetic' ? '79.00' : '80.00',
            scenario === 'gap' ? 3 : 2,
            scenario === 'missing-event',
          );
          if (scenario === 'wallet-mismatch')
            await em.execute('update wagering.wallets set balance=100,version=1 where id=?', [
              owner.id,
            ]);
        }),
      ).rejects.toMatchObject({ code: '23514' });
    }
  },
);
integration(
  'first movement after a zero opening is version two and has no synthetic opening',
  async () => {
    const owner = await database.owner.em.fork().transactional(async (em) => {
      const owner = await wallet(em);
      await movement(em, owner, 'WIN', '0.00', '5.00', 2);
      return owner;
    });
    expect(
      await database.owner.em.execute(
        'select kind,direction,wallet_version from wagering.wallet_ledger where wallet_id=?',
        [owner.id],
      ),
    ).toEqual([{ kind: 'WIN', direction: 'CREDIT', wallet_version: 2 }]);
  },
);
integration(
  'processed financial transaction requires journal, while zero and LOSS do not',
  async () => {
    await expect(
      database.owner.em.fork().transactional(async (em) => {
        const owner = await wallet(em);
        await insertExternalTransaction(em, {
          walletId: owner.id,
          playerId: owner.player,
          kind: 'WIN',
          amount: '10.00',
        });
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await database.owner.em.fork().transactional(async (em) => {
      const owner = await wallet(em);
      for (const [kind, amount] of [
        ['LOSS', '100.00'],
        ['WIN', '0.00'],
      ])
        await insertExternalTransaction(em, {
          walletId: owner.id,
          playerId: owner.player,
          kind: kind!,
          amount: amount!,
        });
    });
  },
);

integration(
  'consolidated financial migration reverses completely and has no legacy opening objects',
  async () => {
    const fixture = await disposableDatabase();
    try {
      const exists = async () =>
        (
          await fixture.owner.em.execute(
            "select to_regclass('wagering.transactions') as transactions, to_regclass('wagering.openings') as openings, to_regprocedure('wagering.validate_opening()') as legacy",
          )
        )[0];
      expect(await exists()).toEqual({
        transactions: 'wagering.transactions',
        openings: null,
        legacy: null,
      });
      await fixture.owner.getMigrator().down({ to: 'Migration202611120001' });
      expect(await exists()).toEqual({ transactions: null, openings: null, legacy: null });
      await fixture.owner.getMigrator().up();
      expect(await exists()).toEqual({
        transactions: 'wagering.transactions',
        openings: null,
        legacy: null,
      });
      const owner = await fixture.owner.em.fork().transactional(async (em) => {
        const owner = await wallet(em);
        await movement(em, owner, 'OPENING', '0.00', '100.00', 1);
        return owner;
      });
      expect(
        await fixture.owner.em.execute(
          'select kind,direction,balance_after::text from wagering.wallet_ledger where wallet_id=?',
          [owner.id],
        ),
      ).toEqual([{ kind: 'OPENING', direction: 'CREDIT', balance_after: '100.00' }]);
      // Upgrade/downgrade of T03 preserves the opening already delivered by PR #16.
      await fixture.owner.getMigrator().down();
      await fixture.owner.getMigrator().up();
      expect(
        await fixture.owner.em.execute(
          'select balance::text,version from wagering.wallets where id=?',
          [owner.id],
        ),
      ).toEqual([{ balance: '100.00', version: 1 }]);
    } finally {
      await fixture.close();
    }
  },
);

integration('transaction kinds cannot reverse their defined debit or credit effect', async () => {
  for (const [kind, after] of [
    ['BET', '120.00'],
    ['WIN', '95.00'],
    ['REFUND', '95.00'],
  ]) {
    await expect(
      database.owner.em.fork().transactional(async (em) => {
        const owner = await wallet(em);
        await movement(em, owner, 'OPENING', '0.00', '100.00', 1);
        await movement(em, owner, kind!, '100.00', after!, 2, false, true);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  }
});

integration(
  'only OPENING may omit the external identity, for every role and every other kind',
  async () => {
    const runtime = await openDatabase(database.config);
    try {
      for (const kind of ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'])
        for (const db of [database.owner, runtime])
          await expect(
            db.em.fork().transactional(async (em) => {
              const owner = await database.owner.em.fork().transactional((setup) => wallet(setup));
              await em.execute(
                `insert into wagering.transactions(id,wallet_id,currency,amount,kind,status) values(?,?,'BRL',0,?,'PROCESSED')`,
                [crypto.randomUUID(), owner.id, kind],
              );
            }),
          ).rejects.toMatchObject({
            code: '23514',
            message: expect.stringContaining('external_identity_complete'),
          });
    } finally {
      await runtime.close(true);
    }
  },
);

integration(
  'opening without its WagerTransactionProcessed event is refused at commit',
  async () => {
    await expect(
      database.owner.em.fork().transactional(async (em) => {
        const owner = await wallet(em);
        const transaction = crypto.randomUUID();
        const [counter] = await em.execute<{ id: string }[]>(
          `select id from wagering.accounts where currency='BRL' and kind='OPENING'`,
        );
        await em.execute(
          `insert into wagering.transactions(id,wallet_id,currency,kind,status,amount) values(?,?,'BRL','OPENING','PROCESSED',100)`,
          [transaction, owner.id],
        );
        await em.execute(
          `insert into wagering.journal(id,transaction_id,wallet_id,currency,amount,debit_account_id,credit_account_id,balance_before,balance_after,wallet_version) values(?,?,?,'BRL',100,?,?,0,100,1)`,
          [crypto.randomUUID(), transaction, owner.id, counter!.id, owner.account],
        );
        await appendEvent(em, owner.id, transaction, 'WalletBalanceChanged');
        await em.execute('update wagering.wallets set balance=100 where id=?', [owner.id]);
      }),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('RESULT_EVENT_REQUIRED'),
    });
  },
);

integration(
  'external records default to processed and terminal transitions remain protected after T03',
  async () => {
    const id = await database.owner.em.fork().transactional(async (em) => {
      const owner = await wallet(em);
      return insertExternalTransaction(em, {
        walletId: owner.id,
        playerId: owner.player,
        kind: 'WIN',
        amount: '0.00',
      });
    });
    expect(
      (
        await database.owner.em.execute('select status from wagering.transactions where id=?', [id])
      )[0].status,
    ).toBe('PROCESSED');
    await expect(
      database.owner.em.fork().transactional(async (em) => {
        const owner = await wallet(em);
        await em.execute(`update wagering.transactions set status='PENDING' where id=?`, [id]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  },
);

integration('SQL and domain policy allow only the documented state transition edges', async () => {
  const states = ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'];
  for (const from of states)
    for (const to of states) {
      const allowed =
        (from === 'PENDING' &&
          ['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'].includes(to)) ||
        (from === 'PENDING_REFERENCE' && ['PROCESSED', 'REJECTED', 'FAILED'].includes(to));
      const write = database.owner.em.fork().transactional(async (em) => {
        const w = await wallet(em);
        const id = await insertExternalTransaction(em, {
          walletId: w.id,
          playerId: w.player,
          kind: 'WIN',
          amount: '0.00',
          status: from as 'PENDING',
          failureCode: ['REJECTED', 'FAILED'].includes(from) ? 'INSUFFICIENT_FUNDS' : null,
          resultEvent: false,
        });
        await em.execute(
          "update wagering.transactions set status=?,failure_code=?,processed_at=case when ?='PROCESSED' then clock_timestamp() end where id=?",
          [to, ['REJECTED', 'FAILED'].includes(to) ? 'INSUFFICIENT_FUNDS' : null, to, id],
        );
        await appendResultEvent(em, w.id, id, to as 'PENDING');
      });
      if (allowed) await write;
      else await expect(write).rejects.toMatchObject({ code: '23514' });
    }
});
