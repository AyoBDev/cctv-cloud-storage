type MigrationBuilder = import('node-pg-migrate/dist/bundle/index').MigrationBuilder;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('cameras', {
    last_seen_at: { type: 'timestamptz' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('cameras', ['last_seen_at']);
}
