type MigrationBuilder = import('node-pg-migrate/dist/bundle/index').MigrationBuilder;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('camera_status', ['provisioning', 'online', 'offline', 'inactive']);

  pgm.createTable('cameras', {
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
    name: { type: 'varchar(255)', notNull: true },
    location: { type: 'varchar(255)' },
    timezone: { type: 'varchar(50)', notNull: true, default: pgm.func("'UTC'") },
    rtsp_url_encrypted: { type: 'text' },
    kvs_stream_name: { type: 'varchar(255)', notNull: true, unique: true },
    kvs_stream_arn: { type: 'text' },
    status: {
      type: 'camera_status',
      notNull: true,
      default: pgm.func("'provisioning'"),
    },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('cameras', 'org_id');
  pgm.createIndex('cameras', 'kvs_stream_name');

  // Reuse existing trigger function
  pgm.sql(`
    CREATE TRIGGER update_cameras_updated_at
      BEFORE UPDATE ON cameras
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('cameras');
  pgm.dropType('camera_status');
}
