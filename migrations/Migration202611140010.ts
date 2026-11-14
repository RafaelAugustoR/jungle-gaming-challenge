import { Migration } from '@mikro-orm/migrations';

/**
 * The publishable-head probe ("is there an earlier unpublished event in this aggregate?") used
 * the full (aggregate_id, sequence) unique index and filtered published rows one by one, so a
 * claim cost pending × published entries on a hot wallet. Indexing only unpublished rows keeps
 * the probe proportional to the backlog, and the planner also uses it for the outer scan once
 * the published history is large.
 *
 * outbox_publishable (Migration202611130006) is replaced: no query used it in the measured
 * shapes (deep single-wallet backlog, backlog spread over many wallets, retry-backoff outage),
 * and it cost one more index entry on every financial transaction insert. The down migration
 * restores it so earlier down migrations still find it.
 */
export class Migration202611140010 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create index outbox_unpublished_by_aggregate
      on wagering.outbox(aggregate_id,sequence) where published_at is null;
      drop index wagering.outbox_publishable;`);
  }

  override async down(): Promise<void> {
    this.addSql(`create index outbox_publishable
      on wagering.outbox(next_attempt_at,occurred_at) where published_at is null and blocked_at is null;
      drop index wagering.outbox_unpublished_by_aggregate;`);
  }
}
