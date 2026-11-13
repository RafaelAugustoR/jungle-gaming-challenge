import { Migration } from '@mikro-orm/migrations';

export class Migration202611130005 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create table wagering.reference_retries (
        transaction_id uuid primary key references wagering.transactions(id),
        deadline timestamptz not null,
        next_attempt_at timestamptz,
        attempts integer not null default 0 check (attempts >= 0),
        correlation_id text not null,
        causation_id text,
        completed_at timestamptz,
        result_balance numeric check (result_balance >= 0 and result_balance < 10000000000000000 and scale(result_balance)<=2),
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
      .addSql(`do $$ begin if exists(select from wagering.reference_retries where completed_at is null) then raise exception 'PENDING_REFERENCES_EXIST'; end if; end $$;
      drop table wagering.reference_retries;`);
  }
}
