// src/db/migrations/003_iot_columns.ts
type MigrationBuilder = import('node-pg-migrate/dist/bundle/index').MigrationBuilder;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('cameras', {
    iot_thing_name: { type: 'varchar(255)' },
    iot_certificate_id: { type: 'varchar(255)' },
    iot_certificate_arn: { type: 'varchar(512)' },
    credentials_issued: { type: 'boolean', notNull: true, default: false },
    credentials_issued_at: { type: 'timestamptz' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('cameras', [
    'iot_thing_name',
    'iot_certificate_id',
    'iot_certificate_arn',
    'credentials_issued',
    'credentials_issued_at',
  ]);
}
