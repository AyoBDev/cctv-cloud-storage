type MigrationBuilder = import('node-pg-migrate/dist/bundle/index').MigrationBuilder;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('face_profiles', {
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
    face_id: {
      type: 'varchar(255)',
      notNull: true,
      unique: true,
    },
    label: {
      type: 'varchar(255)',
      notNull: true,
    },
    image_key: {
      type: 'text',
      notNull: true,
    },
    created_by: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
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

  pgm.createIndex('face_profiles', 'org_id');

  pgm.sql(`
    CREATE TRIGGER update_face_profiles_updated_at
      BEFORE UPDATE ON face_profiles
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('face_profiles');
}
