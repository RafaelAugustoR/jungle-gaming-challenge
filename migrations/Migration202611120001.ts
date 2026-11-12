import { Migration } from '@mikro-orm/migrations';

export class Migration202611120001 extends Migration {
  async up(): Promise<void> { this.addSql('create schema wagering;'); }
  async down(): Promise<void> { this.addSql('drop schema wagering;'); }
}
