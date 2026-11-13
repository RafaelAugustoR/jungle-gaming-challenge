import { Migration } from '@mikro-orm/migrations';

export class Migration202611120004 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table wagering.transactions
        add column reference_external_transaction_id text check (reference_external_transaction_id is null or length(trim(reference_external_transaction_id)) between 1 and 128),
        add column reference_transaction_id uuid references wagering.transactions(id),
        add constraint no_self_reference check (reference_transaction_id is null or reference_transaction_id <> id),
        add constraint resolved_reference_terminal check (reference_transaction_id is null or status in ('PROCESSED','REJECTED','FAILED'));
      create or replace function wagering.transaction_transition() returns trigger language plpgsql as $$
      begin
        if (to_jsonb(new) - array['status','failure_code','processed_at','reference_transaction_id']) is distinct from
           (to_jsonb(old) - array['status','failure_code','processed_at','reference_transaction_id']) then
          raise exception 'IMMUTABLE_TRANSACTION_FIELDS' using errcode='23514';
        end if;
        if not (case old.status when 'PENDING' then new.status in ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')
          when 'PENDING_REFERENCE' then new.status in ('PROCESSED','REJECTED','FAILED') else false end) then
          raise exception 'INVALID_TRANSACTION_TRANSITION' using errcode='23514';
        end if;
        if new.reference_transaction_id is distinct from old.reference_transaction_id and not (
          old.reference_transaction_id is null and new.reference_transaction_id is not null
          and old.status in ('PENDING','PENDING_REFERENCE') and new.status in ('PROCESSED','REJECTED','FAILED')
        ) then raise exception 'IMMUTABLE_RESOLVED_REFERENCE' using errcode='23514'; end if;
        if new.status='PENDING_REFERENCE' and new.reference_transaction_id is not null then
          raise exception 'UNRESOLVED_REFERENCE_REQUIRED' using errcode='23514';
        end if;
        return new;
      end $$;
      grant update(reference_transaction_id) on wagering.transactions to jungle_runtime;
      create unique index one_reversal_per_kind on wagering.transactions(reference_transaction_id,kind)
        where kind in ('REFUND','ROLLBACK') and status='PROCESSED';
      create function wagering.check_processed_reference() returns trigger language plpgsql as $$
      declare t wagering.transactions; r wagering.transactions; j wagering.journal; w wagering.wallets;
      begin
        select * into strict t from wagering.transactions where id=new.id;
        if t.status <> 'PROCESSED' or t.provider_id is null then return null; end if;
        if t.kind='BET' and t.reference_external_transaction_id is not null then raise exception 'BET_REFERENCE_FORBIDDEN' using errcode='23514'; end if;
        if t.kind in ('REFUND','ROLLBACK') and t.reference_external_transaction_id is null then raise exception 'REFERENCE_REQUIRED' using errcode='23514'; end if;
        if t.reference_external_transaction_id is null then
          if t.reference_transaction_id is not null then raise exception 'REFERENCE_IDENTITY_MISMATCH' using errcode='23514'; end if;
          return null;
        end if;
        select * into r from wagering.transactions where id=t.reference_transaction_id;
        if r.id is null or r.status <> 'PROCESSED' then raise exception 'REFERENCE_NOT_PROCESSED' using errcode='23514'; end if;
        if (r.provider_id,r.external_transaction_id,r.wallet_id,r.player_id,r.currency,r.round_id) is distinct from
          (t.provider_id,t.reference_external_transaction_id,t.wallet_id,t.player_id,t.currency,t.round_id) then raise exception 'REFERENCE_CONTEXT_MISMATCH' using errcode='23514'; end if;
        if t.kind in ('REFUND','ROLLBACK') and t.amount <> r.amount then raise exception 'REFERENCE_AMOUNT_MISMATCH' using errcode='23514'; end if;
        if t.kind='ROLLBACK' and t.amount > 0 then
          select * into strict j from wagering.journal where transaction_id=t.id;
          select * into strict w from wagering.wallets where id=t.wallet_id;
          if (j.credit_account_id=w.account_id) <> (r.kind='BET') then raise exception 'REVERSAL_DIRECTION_MISMATCH' using errcode='23514'; end if;
        end if;
        return null;
      end $$;
      create constraint trigger processed_reference_consistency after insert or update on wagering.transactions deferrable initially deferred for each row execute function wagering.check_processed_reference();
    `);
  }
  async down(): Promise<void> {
    this.addSql(`
      do $$ begin if exists(select from wagering.transactions where reference_external_transaction_id is not null or reference_transaction_id is not null) then raise exception 'REFERENCED_TRANSACTIONS_EXIST'; end if; end $$;
      revoke update(reference_transaction_id) on wagering.transactions from jungle_runtime;
      create or replace function wagering.transaction_transition() returns trigger language plpgsql as $$
      begin
        if (to_jsonb(new) - array['status','failure_code','processed_at']) is distinct from (to_jsonb(old) - array['status','failure_code','processed_at']) then
          raise exception 'IMMUTABLE_TRANSACTION_FIELDS' using errcode='23514';
        end if;
        if not (case old.status when 'PENDING' then new.status in ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')
          when 'PENDING_REFERENCE' then new.status in ('PROCESSED','REJECTED','FAILED') else false end) then
          raise exception 'INVALID_TRANSACTION_TRANSITION' using errcode='23514';
        end if;
        return new;
      end $$;
      drop trigger processed_reference_consistency on wagering.transactions;
      drop function wagering.check_processed_reference();
      drop index wagering.one_reversal_per_kind;
      alter table wagering.transactions drop constraint no_self_reference, drop constraint resolved_reference_terminal, drop column reference_transaction_id, drop column reference_external_transaction_id;
    `);
  }
}
