import { Migration } from '@mikro-orm/migrations';

export class Migration202611130005 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table wagering.transactions add column result_balance numeric check (result_balance >= 0 and result_balance < 10000000000000000 and scale(result_balance)<=2);
      alter table wagering.transactions disable trigger transaction_transition;
      update wagering.transactions t set result_balance=(r.body->'balance'->>'amount')::numeric from wagering.submission_receipts r where r.transaction_id=t.id;
      set constraints all immediate;
      alter table wagering.transactions enable trigger transaction_transition;
      set constraints all deferred;
      create or replace function wagering.transaction_transition() returns trigger language plpgsql as $$
      begin
        if (to_jsonb(new) - array['status','failure_code','processed_at','reference_transaction_id','result_balance']) is distinct from
           (to_jsonb(old) - array['status','failure_code','processed_at','reference_transaction_id','result_balance']) then
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
      grant update(result_balance) on wagering.transactions to jungle_runtime;
      create table wagering.reference_retries (
        transaction_id uuid primary key references wagering.transactions(id),
        deadline timestamptz not null,
        next_attempt_at timestamptz,
        attempts integer not null default 0 check (attempts >= 0),
        correlation_id text not null,
        causation_id text,
        completed_at timestamptz,
        check ((completed_at is null) = (next_attempt_at is not null))
      );
      create index reference_retries_due on wagering.reference_retries(next_attempt_at, transaction_id) where completed_at is null;
      insert into wagering.reference_retries(transaction_id,deadline,next_attempt_at,correlation_id,causation_id)
      select t.id,t.created_at + interval '15 minutes',clock_timestamp(),
        coalesce((select payload->>'correlationId' from wagering.outbox where transaction_id=t.id and event_type='WagerTransactionPendingReference' limit 1),t.id::text),
        (select payload->>'causationId' from wagering.outbox where transaction_id=t.id and event_type='WagerTransactionPendingReference' limit 1)
      from wagering.transactions t where t.status='PENDING_REFERENCE';
      grant select,insert,update on wagering.reference_retries to jungle_runtime;
    `);
  }
  async down(): Promise<void> {
    this
      .addSql(`do $$ begin if exists(select from wagering.reference_retries where completed_at is null) then raise exception 'PENDING_REFERENCES_EXIST'; end if;
      if exists(select from wagering.reference_retries where completed_at is not null) then raise exception 'RESOLVED_REFERENCES_EXIST'; end if; end $$;
      drop table wagering.reference_retries;
      revoke update(result_balance) on wagering.transactions from jungle_runtime;
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
      alter table wagering.transactions drop column result_balance;`);
  }
}
