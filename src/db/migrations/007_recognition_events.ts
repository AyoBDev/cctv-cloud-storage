type MigrationBuilder = import('node-pg-migrate/dist/bundle/index').MigrationBuilder;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('event_type', ['known_face', 'unknown_face']);

  pgm.createTable('recognition_events', {
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
    face_profile_id: {
      type: 'uuid',
      references: 'face_profiles(id)',
      onDelete: 'SET NULL',
    },
    event_type: {
      type: 'event_type',
      notNull: true,
    },
    confidence: {
      type: 'decimal(5,2)',
      notNull: true,
    },
    thumbnail_key: {
      type: 'text',
    },
    unknown_face_id: {
      type: 'varchar(255)',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('recognition_events', ['org_id', 'created_at'], {
    name: 'idx_recognition_events_org_created',
  });
  pgm.createIndex('recognition_events', ['org_id', 'camera_id'], {
    name: 'idx_recognition_events_org_camera',
  });
  pgm.createIndex('recognition_events', ['org_id', 'face_profile_id'], {
    name: 'idx_recognition_events_org_face_profile',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('recognition_events');
  pgm.dropType('event_type');
}
