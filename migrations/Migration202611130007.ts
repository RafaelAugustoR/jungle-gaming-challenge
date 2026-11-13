import { Migration } from '@mikro-orm/migrations';
export class Migration202611130007 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create schema messaging;
      create table messaging.command_inbox (
        consumer_name text not null, message_id text not null,
        request_hash text not null check(length(request_hash)=64),
        transaction_id uuid not null references wagering.transactions(id),
        received_at timestamptz not null default clock_timestamp(),
        primary key(consumer_name,message_id)
      );
      grant usage on schema messaging to jungle_runtime;
      grant select,insert on messaging.command_inbox to jungle_runtime;`);
  }
  override async down(): Promise<void> {
    this.addSql('drop table messaging.command_inbox; drop schema messaging;');
  }
}
