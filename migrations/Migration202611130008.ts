import { Migration } from '@mikro-orm/migrations';
export class Migration202611130008 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create schema demo;
      create table demo.scenario_audit (
        id uuid primary key,
        actor_id text not null,
        provider_id text not null,
        scenario text not null check (scenario in ('duplicate','race','out-of-order')),
        wallet_id uuid not null references wagering.wallets(id),
        external_transaction_ids text[] not null default '{}',
        transaction_ids uuid[] not null default '{}',
        outcome jsonb not null,
        created_at timestamptz not null default clock_timestamp()
      );
      create index scenario_audit_created_at on demo.scenario_audit(created_at desc);
      grant usage on schema demo to jungle_runtime;
      grant select,insert,update on demo.scenario_audit to jungle_runtime;`);
  }
  override async down(): Promise<void> {
    this.addSql('drop table demo.scenario_audit; drop schema demo;');
  }
}
