import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { retryUntil } from './poll';
export async function lockWalletRows(em: EntityManager, ids: string | string[]) {
  const wallets = Array.isArray(ids) ? ids : [ids];
  if (!wallets.length) throw new Error('Wallet barrier needs at least one wallet');
  await em.execute(
    `select id from wagering.wallets where id in (${wallets.map(() => '?').join(',')}) order by id for update`,
    wallets,
  );
}
export async function holdWallets(orm: MikroORM, ids: string | string[]) {
  const em = orm.em.fork();
  await em.begin();
  try {
    await lockWalletRows(em, ids);
    return em;
  } catch (error) {
    await em.rollback();
    throw error;
  }
}
export async function waitForWalletLock(
  orm: MikroORM,
  minimum = 1,
  applicationPrefix = '',
  timeoutMs = 8000,
) {
  return retryUntil(
    async () => {
      const [row] = await orm.em.fork().execute<{ n: number }[]>(
        `select count(distinct a.application_name)::int n
      from pg_stat_activity a where a.datname=current_database() and a.wait_event_type='Lock'
      and a.application_name like ? and exists(select from pg_locks held
        where held.pid=any(pg_blocking_pids(a.pid)) and held.granted
          and held.relation='wagering.wallets'::regclass)`,
        [applicationPrefix + '%'],
      );
      return row!.n;
    },
    (count) => count >= minimum,
    timeoutMs,
  );
}
