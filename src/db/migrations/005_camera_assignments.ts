import type { MigrationBuilder } from 'node-pg-migrate/dist/bundle/index';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('camera_assignments', {
    camera_id: {
      type: 'uuid',
      notNull: true,
      references: 'cameras(id)',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    assigned_by: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
    },
    assigned_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.addConstraint('camera_assignments', 'camera_assignments_pkey', {
    primaryKey: ['camera_id', 'user_id'],
  });

  pgm.createIndex('camera_assignments', 'user_id', {
    name: 'idx_camera_assignments_user',
  });

  pgm.createIndex('camera_assignments', 'camera_id', {
    name: 'idx_camera_assignments_camera',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('camera_assignments');
}
