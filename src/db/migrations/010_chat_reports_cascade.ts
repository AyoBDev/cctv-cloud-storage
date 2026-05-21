import type { MigrationBuilder } from 'node-pg-migrate/dist/bundle/index';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE chat_reports
      DROP CONSTRAINT chat_reports_group_id_fkey,
      ADD CONSTRAINT chat_reports_group_id_fkey
        FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE chat_reports
      DROP CONSTRAINT chat_reports_group_id_fkey,
      ADD CONSTRAINT chat_reports_group_id_fkey
        FOREIGN KEY (group_id) REFERENCES chat_groups(id);
  `);
}
