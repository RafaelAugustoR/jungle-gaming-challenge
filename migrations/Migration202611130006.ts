import { Migration } from '@mikro-orm/migrations';

export class Migration202611130006 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table wagering.outbox
        add column published_at timestamptz,
        add column lease_token uuid,
        add column lease_until timestamptz,
        add column attempts integer not null default 0 check (attempts>=0),
        add column next_attempt_at timestamptz not null default clock_timestamp(),
        add column blocked_at timestamptz,
        add column last_error_code text,
        add constraint outbox_lease_pair check ((lease_token is null)=(lease_until is null));
      drop trigger outbox_immutable on wagering.outbox;
      create trigger outbox_no_delete before delete or truncate on wagering.outbox for each statement execute function wagering.immutable_record();
      create function wagering.outbox_identity() returns trigger language plpgsql as $$
      begin
        if (new.event_id,new.aggregate_id,new.transaction_id,new.sequence,new.event_type,new.payload,new.occurred_at)
          is distinct from (old.event_id,old.aggregate_id,old.transaction_id,old.sequence,old.event_type,old.payload,old.occurred_at)
        then raise exception 'IMMUTABLE_EVENT' using errcode='23514'; end if;
        if old.published_at is not null then raise exception 'EVENT_ALREADY_PUBLISHED' using errcode='23514'; end if;
        return new;
      end $$;
      create trigger outbox_identity before update on wagering.outbox for each row execute function wagering.outbox_identity();
      create index outbox_publishable on wagering.outbox(next_attempt_at,occurred_at) where published_at is null and blocked_at is null;
      grant update(published_at,lease_token,lease_until,attempts,next_attempt_at,blocked_at,last_error_code) on wagering.outbox to jungle_runtime;
      create table wagering.event_inbox (
        consumer_name text not null, event_id uuid not null, payload_hash text not null,
        aggregate_id uuid not null, sequence integer not null check(sequence>0),
        processed_at timestamptz not null default clock_timestamp(), primary key(consumer_name,event_id)
      );
      create trigger event_inbox_immutable before update or delete or truncate on wagering.event_inbox for each statement execute function wagering.immutable_record();
      create table wagering.event_projection (
        consumer_name text not null, aggregate_id uuid not null,
        sequence integer not null check(sequence>0), event_id uuid not null,
        event_type text not null, balance jsonb, wallet_version integer,
        primary key(consumer_name,aggregate_id)
      );
      grant select,insert on wagering.event_inbox to jungle_runtime;
      grant select,insert,update on wagering.event_projection to jungle_runtime;
    `);
  }
  async down(): Promise<void> {
    this.addSql(`
      drop table wagering.event_projection,wagering.event_inbox;
      drop trigger outbox_identity on wagering.outbox;
      drop function wagering.outbox_identity();
      drop trigger outbox_no_delete on wagering.outbox;
      create trigger outbox_immutable before update or delete or truncate on wagering.outbox for each statement execute function wagering.immutable_record();
      drop index wagering.outbox_publishable;
      alter table wagering.outbox drop constraint outbox_lease_pair,
        drop column published_at,drop column lease_token,drop column lease_until,
        drop column attempts,drop column next_attempt_at,drop column blocked_at,drop column last_error_code;
    `);
  }
}
