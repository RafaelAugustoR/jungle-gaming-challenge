import { Migration } from '@mikro-orm/migrations';

const identity = `provider_id is not null and external_transaction_id is not null and idempotency_key is not null and request_hash is not null and player_id is not null and round_id is not null and game_id is not null
            and length(trim(provider_id)) between 1 and 128 and length(trim(external_transaction_id)) between 1 and 128 and length(trim(idempotency_key)) between 1 and 128
            and request_hash ~ '^[0-9a-f]{64}$' and length(trim(player_id)) between 1 and 128 and length(trim(round_id)) between 1 and 128 and length(trim(game_id)) between 1 and 128`;
const anonymous = `provider_id is null and external_transaction_id is null and idempotency_key is null and request_hash is null and player_id is null and round_id is null and game_id is null`;

/**
 * Closes two schema gaps (audit F01/F02):
 *
 * - `external_identity_complete` let any kind omit the whole external identity. Only the internal
 *   OPENING may: every BET/WIN/LOSS/REFUND/ROLLBACK now needs provider, external id, idempotency
 *   key and request hash, so the composite UNIQUE constraints and the receipt/result-event
 *   trigger (which keys on provider_id) cover every external operation.
 * - §11 requires `WagerTransactionProcessed` for every applied transaction. The result-event
 *   check now also applies to OPENING, and openings committed before this migration get their
 *   processed event appended to the outbox (after the wallet's existing events, so the
 *   per-wallet order already published is untouched).
 *
 * The down migration restores the previous constraint and trigger; backfilled outbox rows stay,
 * since the outbox is append-only and they may already be published.
 */
export class Migration202611140011 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wagering.transactions drop constraint external_identity_complete;
      alter table wagering.transactions add constraint external_identity_complete check (
        (kind = 'OPENING' and ${anonymous})
        or (kind <> 'OPENING' and ${identity}));
      create or replace function wagering.check_external_submission() returns trigger language plpgsql as $$
      declare t wagering.transactions;
      begin
        select * into strict t from wagering.transactions where id=new.id;
        if t.provider_id is not null then
          if not exists(select from wagering.wallets where id=t.wallet_id and player_id=t.player_id) then raise exception 'PLAYER_MISMATCH' using errcode='23514'; end if;
          if not exists(select from wagering.submission_receipts where transaction_id=t.id) then raise exception 'RECEIPT_REQUIRED' using errcode='23514'; end if;
        end if;
        -- Internal OPENING included: every applied transaction has its result event.
        if t.status in ('PROCESSED','REJECTED','PENDING_REFERENCE') and not exists(select from wagering.outbox where transaction_id=t.id and event_type=case t.status
          when 'PROCESSED' then 'WagerTransactionProcessed' when 'REJECTED' then 'WagerTransactionRejected'
          when 'PENDING_REFERENCE' then 'WagerTransactionPendingReference' else '' end)
        then raise exception 'RESULT_EVENT_REQUIRED' using errcode='23514'; end if;
        return null;
      end $$;
      -- One event id per opening: gen_random_uuid() in the select list of a MATERIALIZED CTE is
      -- evaluated per row. An uncorrelated subquery (lateral or not) may be evaluated once and
      -- reused by the planner, which repeats the id and violates outbox_pkey.
      with missing as materialized (
        select gen_random_uuid() as event_id, t.id as transaction_id, t.wallet_id, t.currency, t.amount,
          w.player_id, b.payload as balance_payload, b.occurred_at
        from wagering.transactions t
        join wagering.wallets w on w.id=t.wallet_id
        join wagering.outbox b on b.transaction_id=t.id and b.event_type='WalletBalanceChanged'
        where t.kind='OPENING'
          and not exists(select from wagering.outbox o where o.transaction_id=t.id and o.event_type='WagerTransactionProcessed')
      )
      insert into wagering.outbox(event_id,aggregate_id,transaction_id,sequence,event_type,payload,occurred_at)
      select m.event_id, m.wallet_id, m.transaction_id,
        (select max(o.sequence) from wagering.outbox o where o.aggregate_id=m.wallet_id) + row_number() over (partition by m.wallet_id order by m.transaction_id),
        'WagerTransactionProcessed',
        jsonb_strip_nulls(jsonb_build_object(
          'eventId', m.event_id, 'aggregateId', m.wallet_id,
          'correlationId', coalesce(m.balance_payload->>'correlationId', m.transaction_id::text),
          'causationId', m.balance_payload->>'causationId',
          'occurredAt', to_char(m.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'eventType', 'WagerTransactionProcessed', 'version', 1,
          'actorId', m.balance_payload->>'actorId',
          'data', jsonb_build_object(
            'transactionId', m.transaction_id, 'walletId', m.wallet_id, 'playerId', m.player_id, 'kind', 'OPENING',
            'money', jsonb_build_object('amount', to_char(m.amount, 'FM9999999999999990.00'), 'currency', m.currency),
            'balance', jsonb_build_object('amount', to_char(m.amount, 'FM9999999999999990.00'), 'currency', m.currency)))),
        m.occurred_at
      from missing m;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table wagering.transactions drop constraint external_identity_complete;
      alter table wagering.transactions add constraint external_identity_complete check (
        (${anonymous})
        or (kind <> 'OPENING' and ${identity}));
      create or replace function wagering.check_external_submission() returns trigger language plpgsql as $$
      declare t wagering.transactions;
      begin
        select * into strict t from wagering.transactions where id=new.id;
        if t.provider_id is not null then
          if not exists(select from wagering.wallets where id=t.wallet_id and player_id=t.player_id) then raise exception 'PLAYER_MISMATCH' using errcode='23514'; end if;
          if not exists(select from wagering.submission_receipts where transaction_id=t.id) then raise exception 'RECEIPT_REQUIRED' using errcode='23514'; end if;
          if t.status in ('PROCESSED','REJECTED','PENDING_REFERENCE') and not exists(select from wagering.outbox where transaction_id=t.id and event_type=case t.status
            when 'PROCESSED' then 'WagerTransactionProcessed' when 'REJECTED' then 'WagerTransactionRejected'
            when 'PENDING_REFERENCE' then 'WagerTransactionPendingReference' else '' end)
          then raise exception 'RESULT_EVENT_REQUIRED' using errcode='23514'; end if;
        end if;
        return null;
      end $$;
    `);
  }
}
