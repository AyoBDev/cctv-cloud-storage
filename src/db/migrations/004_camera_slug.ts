// src/db/migrations/004_camera_slug.ts
type MigrationBuilder = import('node-pg-migrate/dist/bundle/index').MigrationBuilder;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Add auto-increment camera counter to organisations
  pgm.addColumns('organizations', {
    camera_seq: { type: 'integer', notNull: true, default: 0 },
  });

  // Add slug to cameras (nullable initially for backfill)
  pgm.addColumns('cameras', {
    slug: { type: 'varchar(100)' },
  });

  // Backfill existing cameras: extract last part of kvs_stream_name after the first hyphen
  pgm.sql(`
    UPDATE cameras
    SET slug = SUBSTRING(kvs_stream_name FROM POSITION('-' IN kvs_stream_name) + 1)
    WHERE slug IS NULL
  `);

  // Now make slug NOT NULL
  pgm.alterColumn('cameras', 'slug', { notNull: true });

  // Unique constraint: slug must be unique within an org
  pgm.addConstraint('cameras', 'cameras_org_id_slug_unique', {
    unique: ['org_id', 'slug'],
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('cameras', 'cameras_org_id_slug_unique');
  pgm.dropColumns('cameras', ['slug']);
  pgm.dropColumns('organizations', ['camera_seq']);
}
