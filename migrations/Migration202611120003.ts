import { Migration } from '@mikro-orm/migrations';

export class Migration202611120003 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table wagering.transactions drop constraint transactions_status_check;
      alter table wagering.transactions add constraint transactions_status_check check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'));
      alter table wagering.transactions
        add column provider_id text, add column external_transaction_id text,
        add column idempotency_key text, add column request_hash text,
        add column player_id text, add column round_id text, add column game_id text,
        add column failure_code text, add column processed_at timestamptz,
        add constraint provider_idempotency_key unique(provider_id,idempotency_key),
        add constraint provider_external_transaction unique(provider_id,external_transaction_id),
        add constraint external_identity_complete check (
          (provider_id is null and external_transaction_id is null and idempotency_key is null and request_hash is null and player_id is null and round_id is null and game_id is null)
          or (kind <> 'OPENING' and provider_id is not null and external_transaction_id is not null and idempotency_key is not null and request_hash is not null and player_id is not null and round_id is not null and game_id is not null
            and length(trim(provider_id)) between 1 and 128 and length(trim(external_transaction_id)) between 1 and 128 and length(trim(idempotency_key)) between 1 and 128
            and request_hash ~ '^[0-9a-f]{64}$' and length(trim(player_id)) between 1 and 128 and length(trim(round_id)) between 1 and 128 and length(trim(game_id)) between 1 and 128)),
        add constraint transaction_failure check ((status in ('REJECTED','FAILED')) = (failure_code is not null) and (failure_code is null or length(trim(failure_code)) > 0)),
        add constraint external_processed_at check (provider_id is null or ((status='PROCESSED') = (processed_at is not null))),
        add constraint internal_opening_processed check (kind <> 'OPENING' or status='PROCESSED');
      create table wagering.submission_receipts (
        transaction_id uuid primary key references wagering.transactions(id),
        http_status integer not null check (http_status in (200,202,422)), body jsonb not null check (jsonb_typeof(body)='object')
      );
      create trigger receipts_immutable before update or delete or truncate on wagering.submission_receipts for each statement execute function wagering.immutable_record();
      drop trigger transactions_immutable on wagering.transactions;
      create trigger transactions_no_delete before delete or truncate on wagering.transactions for each statement execute function wagering.immutable_record();
      create function wagering.transaction_transition() returns trigger language plpgsql as $$
      begin
        if (to_jsonb(new) - array['status','failure_code','processed_at']) is distinct from (to_jsonb(old) - array['status','failure_code','processed_at']) then
          raise exception 'IMMUTABLE_TRANSACTION_FIELDS' using errcode='23514';
        end if;
        if not (case old.status
          when 'PENDING' then new.status in ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')
          when 'PENDING_REFERENCE' then new.status in ('PROCESSED','REJECTED','FAILED')
          else false end) then
          raise exception 'INVALID_TRANSACTION_TRANSITION' using errcode='23514';
        end if;
        return new;
      end $$;
      create trigger transaction_transition before update on wagering.transactions for each row execute function wagering.transaction_transition();
      drop trigger transaction_consistency on wagering.transactions;
      create constraint trigger transaction_consistency after insert or update on wagering.transactions deferrable initially deferred for each row execute function wagering.check_transaction_journal();
      create function wagering.check_external_submission() returns trigger language plpgsql as $$
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
      create constraint trigger external_submission_consistency after insert or update on wagering.transactions deferrable initially deferred for each row execute function wagering.check_external_submission();
      grant select,insert on wagering.submission_receipts to jungle_runtime;
      grant update(status,failure_code,processed_at) on wagering.transactions to jungle_runtime;
    `);
  }
  async down(): Promise<void> {
    this.addSql(`
      -- Refuse to discard accepted external operations. Down is for disposable databases.
      do $$ begin if exists(select from wagering.transactions where provider_id is not null) then raise exception 'EXTERNAL_TRANSACTIONS_EXIST'; end if; end $$;
      revoke update(status,failure_code,processed_at) on wagering.transactions from jungle_runtime;
      drop trigger external_submission_consistency on wagering.transactions;
      drop function wagering.check_external_submission();
      drop trigger transaction_transition on wagering.transactions;
      drop function wagering.transaction_transition();
      drop trigger transactions_no_delete on wagering.transactions;
      create trigger transactions_immutable before update or delete or truncate on wagering.transactions for each statement execute function wagering.immutable_record();
      drop trigger transaction_consistency on wagering.transactions;
      create constraint trigger transaction_consistency after insert on wagering.transactions deferrable initially deferred for each row execute function wagering.check_transaction_journal();
      drop table wagering.submission_receipts;
      alter table wagering.transactions drop constraint provider_idempotency_key, drop constraint provider_external_transaction,
        drop constraint external_identity_complete, drop constraint transaction_failure, drop constraint external_processed_at, drop constraint internal_opening_processed;
      alter table wagering.transactions drop column provider_id, drop column external_transaction_id, drop column idempotency_key,
        drop column request_hash, drop column player_id, drop column round_id, drop column game_id, drop column failure_code, drop column processed_at;
      alter table wagering.transactions drop constraint transactions_status_check;
      alter table wagering.transactions add constraint transactions_status_check check (status='PROCESSED');
    `);
  }
}
