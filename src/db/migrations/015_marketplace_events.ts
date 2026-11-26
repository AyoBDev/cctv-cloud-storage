type MigrationBuilder = import('node-pg-migrate/dist/bundle/index').MigrationBuilder;

/**
 * Append-only log of every AWS Marketplace event EventBridge delivers to us.
 *
 * The primary key is the EventBridge envelope `id`, so a redelivered event is a
 * no-op insert. Rows are never used to decide access: they record what arrived,
 * when it was processed, and why processing failed (for SQS retries and support).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('marketplace_events', {
    event_id: { type: 'varchar(255)', primaryKey: true },
    detail_type: { type: 'varchar(255)', notNull: true },
    agreement_id: { type: 'varchar(255)' },
    license_arn: { type: 'text' },
    aws_account_id: { type: 'varchar(255)' },
    payload: { type: 'jsonb', notNull: true },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    processed_at: { type: 'timestamptz' },
    error: { type: 'text' },
  });
  pgm.createIndex('marketplace_events', 'aws_account_id');
  pgm.createIndex('marketplace_events', 'received_at');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('marketplace_events');
}
