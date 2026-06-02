type MigrationBuilder = import('node-pg-migrate/dist/bundle/index').MigrationBuilder;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Credential storage columns on cameras
  pgm.addColumns('cameras', {
    iot_certificate_pem_encrypted: { type: 'text' },
    iot_private_key_encrypted: { type: 'text' },
  });

  // Duration column on cameras (auto-disable after timestamp)
  pgm.addColumns('cameras', {
    face_detection_duration_until: { type: 'timestamptz' },
  });

  // Make cameras face_detection_enabled nullable (null = inherit from org)
  pgm.alterColumn('cameras', 'face_detection_enabled', {
    notNull: false,
    default: null,
  });

  // Face detection columns on organizations
  pgm.addColumns('organizations', {
    face_detection_enabled: { type: 'boolean', notNull: true, default: true },
    face_detection_start_time: { type: 'time' },
    face_detection_end_time: { type: 'time' },
    face_detection_duration_until: { type: 'timestamptz' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('organizations', [
    'face_detection_enabled',
    'face_detection_start_time',
    'face_detection_end_time',
    'face_detection_duration_until',
  ]);

  pgm.alterColumn('cameras', 'face_detection_enabled', {
    notNull: true,
    default: true,
  });

  pgm.dropColumns('cameras', [
    'iot_certificate_pem_encrypted',
    'iot_private_key_encrypted',
    'face_detection_duration_until',
  ]);
}
