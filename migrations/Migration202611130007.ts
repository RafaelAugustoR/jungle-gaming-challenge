import { Migration } from '@mikro-orm/migrations';
export class Migration202611130007 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create schema messaging;
      create table messaging.command_inbox (
        consumer_name text not null, message_id text not null,
        request_hash text not null check(length(request_hash)=64),
        transaction_id uuid references wagering.transactions(id),
        received_at timestamptz not null default clock_timestamp(),
        primary key(consumer_name,message_id)
      );
      create function messaging.complete_inbox() returns trigger language plpgsql as $$
      begin
        if exists(select 1 from messaging.command_inbox where consumer_name=new.consumer_name and message_id=new.message_id and transaction_id is null) then
          raise exception 'Incomplete command inbox' using errcode='23514';
        end if;
        return null;
      end $$;
      create constraint trigger complete_inbox after insert or update on messaging.command_inbox deferrable initially deferred for each row execute function messaging.complete_inbox();
      create function messaging.protect_inbox() returns trigger language plpgsql as $$
      begin
        if old.transaction_id is not null or (to_jsonb(new)-'transaction_id') is distinct from (to_jsonb(old)-'transaction_id') then
          raise exception 'Command inbox is immutable' using errcode='23514';
        end if;
        return new;
      end $$;
      create trigger protect_inbox before update on messaging.command_inbox for each row execute function messaging.protect_inbox();
      create trigger inbox_immutable before delete or truncate on messaging.command_inbox for each statement execute function wagering.immutable_record();
      grant usage on schema messaging to jungle_runtime;
      grant select,insert on messaging.command_inbox to jungle_runtime;
      grant update(transaction_id) on messaging.command_inbox to jungle_runtime;`);
  }
  override async down(): Promise<void> {
    this.addSql(
      'drop table messaging.command_inbox; drop function messaging.complete_inbox(),messaging.protect_inbox(); drop schema messaging;',
    );
  }
}
