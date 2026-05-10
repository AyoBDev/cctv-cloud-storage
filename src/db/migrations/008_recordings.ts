type MigrationBuilder = import('node-pg-migrate/dist/bundle/index').MigrationBuilder;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('recordings', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    org_id: {
      type: 'uuid',
      notNull: true,
      references: 'organizations(id)',
      onDelete: 'CASCADE',
    },
    camera_id: {
      type: 'uuid',
      notNull: true,
      references: 'cameras(id)',
      onDelete: 'CASCADE',
    },
    s3_key: {
      type: 'text',
      notNull: true,
    },
    start_time: {
      type: 'timestamptz',
      notNull: true,
    },
    end_time: {
      type: 'timestamptz',
      notNull: true,
    },
    duration_seconds: {
      type: 'integer',
      notNull: true,
    },
    file_size_bytes: {
      type: 'bigint',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('recordings', ['org_id', 'camera_id', { name: 'start_time', sort: 'DESC' }], {
    name: 'idx_recordings_org_camera_start',
  });

  pgm.addConstraint('recordings', 'recordings_camera_start_unique', {
    unique: ['camera_id', 'start_time'],
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('recordings');
}
