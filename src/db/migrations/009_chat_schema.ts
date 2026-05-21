import type { MigrationBuilder } from 'node-pg-migrate/dist/bundle/index';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Enums
  pgm.createType('chat_member_role', ['owner', 'member']);
  pgm.createType('chat_message_type', ['text', 'media', 'system']);
  pgm.createType('chat_report_status', ['pending', 'reviewed', 'dismissed']);
  pgm.createType('push_token_platform', ['ios', 'android', 'web']);

  // 1. chat_groups
  pgm.createTable('chat_groups', {
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
    name: {
      type: 'varchar(100)',
      notNull: true,
    },
    description: {
      type: 'text',
    },
    created_by: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
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

  pgm.createIndex('chat_groups', 'org_id', {
    name: 'idx_chat_groups_org_id',
  });

  // 2. chat_group_members
  pgm.createTable('chat_group_members', {
    group_id: {
      type: 'uuid',
      notNull: true,
      references: 'chat_groups(id)',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    role: {
      type: 'chat_member_role',
      notNull: true,
      default: pgm.func("'member'"),
    },
    muted_until: {
      type: 'timestamptz',
    },
    joined_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.addConstraint('chat_group_members', 'chat_group_members_pkey', {
    primaryKey: ['group_id', 'user_id'],
  });

  pgm.createIndex('chat_group_members', 'user_id', {
    name: 'idx_chat_group_members_user',
  });

  // 3. chat_messages
  pgm.createTable('chat_messages', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    group_id: {
      type: 'uuid',
      notNull: true,
      references: 'chat_groups(id)',
      onDelete: 'CASCADE',
    },
    sender_id: {
      type: 'uuid',
      references: 'users(id)',
    },
    type: {
      type: 'chat_message_type',
      notNull: true,
    },
    content: {
      type: 'text',
      notNull: true,
    },
    media_url: {
      type: 'text',
    },
    media_type: {
      type: 'varchar(50)',
    },
    edited_at: {
      type: 'timestamptz',
    },
    deleted_at: {
      type: 'timestamptz',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('chat_messages', ['group_id', 'created_at'], {
    name: 'idx_chat_messages_group_created',
  });

  // 4. chat_message_reactions
  pgm.createTable('chat_message_reactions', {
    message_id: {
      type: 'uuid',
      notNull: true,
      references: 'chat_messages(id)',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    emoji: {
      type: 'varchar(32)',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.addConstraint('chat_message_reactions', 'chat_message_reactions_pkey', {
    primaryKey: ['message_id', 'user_id', 'emoji'],
  });

  // 5. chat_read_receipts
  pgm.createTable('chat_read_receipts', {
    group_id: {
      type: 'uuid',
      notNull: true,
      references: 'chat_groups(id)',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    last_read_message_id: {
      type: 'uuid',
      notNull: true,
      references: 'chat_messages(id)',
    },
    read_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.addConstraint('chat_read_receipts', 'chat_read_receipts_pkey', {
    primaryKey: ['group_id', 'user_id'],
  });

  // 6. chat_reports
  pgm.createTable('chat_reports', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    group_id: {
      type: 'uuid',
      notNull: true,
      references: 'chat_groups(id)',
    },
    reported_by: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
    },
    reported_user: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
    },
    message_id: {
      type: 'uuid',
      references: 'chat_messages(id)',
    },
    reason: {
      type: 'text',
      notNull: true,
    },
    status: {
      type: 'chat_report_status',
      notNull: true,
      default: pgm.func("'pending'"),
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // 7. user_push_tokens
  pgm.createTable('user_push_tokens', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    platform: {
      type: 'push_token_platform',
      notNull: true,
    },
    token: {
      type: 'text',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.addConstraint('user_push_tokens', 'user_push_tokens_user_token_unique', {
    unique: ['user_id', 'token'],
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('user_push_tokens');
  pgm.dropTable('chat_reports');
  pgm.dropTable('chat_read_receipts');
  pgm.dropTable('chat_message_reactions');
  pgm.dropTable('chat_messages');
  pgm.dropTable('chat_group_members');
  pgm.dropTable('chat_groups');

  pgm.dropType('push_token_platform');
  pgm.dropType('chat_report_status');
  pgm.dropType('chat_message_type');
  pgm.dropType('chat_member_role');
}
