import { Migration } from '@mikro-orm/migrations';

export class Migration202611130009 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create index transactions_created_at_id_desc
      on wagering.transactions(created_at desc,id desc);
      create index transactions_wallet_created_at_id_desc
      on wagering.transactions(wallet_id,created_at desc,id desc);`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index wagering.transactions_wallet_created_at_id_desc;
      drop index wagering.transactions_created_at_id_desc;`);
  }
}
