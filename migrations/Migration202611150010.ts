import { Migration } from '@mikro-orm/migrations';

/**
 * The publishable-head probe ("is there an earlier unpublished event in this aggregate?") used
 * the full (aggregate_id, sequence) unique index and filtered published rows one by one, so a
 * claim cost pending × published entries on a hot wallet. Indexing only unpublished rows keeps
 * the probe proportional to the backlog; rows leave the index as soon as they are published.
 */
export class Migration202611150010 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create index outbox_unpublished_by_aggregate
      on wagering.outbox(aggregate_id,sequence) where published_at is null;`);
  }

  override async down(): Promise<void> {
    this.addSql('drop index wagering.outbox_unpublished_by_aggregate;');
  }
}
