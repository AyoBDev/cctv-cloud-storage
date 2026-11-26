type MigrationBuilder = import('node-pg-migrate/dist/bundle/index').MigrationBuilder;

/**
 * AWS Marketplace SaaS contract integration.
 *
 * - marketplace_registrations: a buyer who arrived from AWS Marketplace and whose
 *   registration token was resolved, but who has not yet signed up or linked an org.
 *   The browser only ever holds a random reference; we store its SHA-256 hash.
 * - marketplace_customers: one row per org that is paid for through AWS Marketplace.
 *   Orgs created by the Super Admin have no row here and are unaffected.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('marketplace_customer_status', ['pending_activation', 'active', 'cancelled']);

  pgm.createTable('marketplace_registrations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    reference_hash: { type: 'char(64)', notNull: true, unique: true },
    aws_account_id: { type: 'varchar(255)', notNull: true },
    license_arn: { type: 'text' },
    product_code: { type: 'varchar(255)', notNull: true },
    agreement_id: { type: 'varchar(255)' },
    is_free_trial: { type: 'boolean', notNull: true, default: false },
    expires_at: { type: 'timestamptz', notNull: true },
    consumed_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('marketplace_registrations', 'aws_account_id');

  pgm.createTable('marketplace_customers', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: {
      type: 'uuid',
      notNull: true,
      unique: true,
      references: 'organizations',
      onDelete: 'CASCADE',
    },
    // One AWS account can be linked to exactly one org.
    aws_account_id: { type: 'varchar(255)', notNull: true, unique: true },
    license_arn: { type: 'text' },
    product_code: { type: 'varchar(255)', notNull: true },
    agreement_id: { type: 'varchar(255)' },
    status: {
      type: 'marketplace_customer_status',
      notNull: true,
      default: 'pending_activation',
    },
    camera_limit: { type: 'integer', notNull: true, default: 0 },
    entitlement_expires_at: { type: 'timestamptz' },
    last_synced_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('marketplace_customers');
  pgm.dropTable('marketplace_registrations');
  pgm.dropType('marketplace_customer_status');
}
