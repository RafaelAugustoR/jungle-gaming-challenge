import { createHash } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';

type Status = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';

const resultEvent: Record<Status, string | undefined> = {
  PENDING: undefined,
  FAILED: undefined,
  PROCESSED: 'WagerTransactionProcessed',
  REJECTED: 'WagerTransactionRejected',
  PENDING_REFERENCE: 'WagerTransactionPendingReference',
};

/** Appends one outbox row at the wallet's next sequence. */
export async function appendEvent(
  em: EntityManager,
  walletId: string,
  transactionId: string,
  eventType: string,
) {
  await em.execute(
    `insert into wagering.outbox(event_id,aggregate_id,transaction_id,sequence,event_type,payload)
     select gen_random_uuid(),?,?,coalesce(max(sequence),0)+1,?,'{}'::jsonb from wagering.outbox where aggregate_id=?`,
    [walletId, transactionId, eventType, walletId],
  );
}

/** Result event the schema requires for a transaction in `status` (none for PENDING/FAILED). */
export async function appendResultEvent(
  em: EntityManager,
  walletId: string,
  transactionId: string,
  status: Status,
) {
  const eventType = resultEvent[status];
  if (eventType) await appendEvent(em, walletId, transactionId, eventType);
}

/**
 * Inserts a provider transaction the way the schema demands of every non-OPENING kind:
 * complete external identity and a submission receipt, plus its result event unless
 * `resultEvent: false`. Financial effects (journal, wallet update, balance event) stay with
 * the caller, since those are what most SQL tests exercise.
 */
export async function insertExternalTransaction(
  em: EntityManager,
  input: {
    walletId: string;
    playerId: string;
    kind: string;
    amount: string;
    status?: Status;
    failureCode?: string | null;
    id?: string;
    resultEvent?: boolean;
  },
) {
  const id = input.id ?? crypto.randomUUID();
  const status = input.status ?? 'PROCESSED';
  await em.execute(
    `insert into wagering.transactions(id,wallet_id,currency,amount,kind,status,failure_code,provider_id,external_transaction_id,
       idempotency_key,request_hash,player_id,round_id,game_id,processed_at)
     values(?,?,'BRL',?,?,?,?,'fixture-provider',?,?,?,?,'round','game',case when ?='PROCESSED' then clock_timestamp() end)`,
    [
      id,
      input.walletId,
      input.amount,
      input.kind,
      status,
      input.failureCode ?? null,
      `external-${id}`,
      `key-${id}`,
      createHash('sha256').update(id).digest('hex'),
      input.playerId,
      status,
    ],
  );
  await em.execute(
    `insert into wagering.submission_receipts(transaction_id,http_status,body) values(?,?,'{}'::jsonb)`,
    [id, status === 'REJECTED' ? 422 : status === 'PROCESSED' ? 200 : 202],
  );
  if (input.resultEvent !== false) await appendResultEvent(em, input.walletId, id, status);
  return id;
}
