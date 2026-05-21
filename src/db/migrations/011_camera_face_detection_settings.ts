import type { MigrationBuilder } from 'node-pg-migrate/dist/bundle/index';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('cameras', {
    face_detection_enabled: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    face_detection_start_time: {
      type: 'time',
    },
    face_detection_end_time: {
      type: 'time',
    },
    alert_cooldown_minutes: {
      type: 'integer',
      notNull: true,
      default: 5,
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('cameras', [
    'face_detection_enabled',
    'face_detection_start_time',
    'face_detection_end_time',
    'alert_cooldown_minutes',
  ]);
}
