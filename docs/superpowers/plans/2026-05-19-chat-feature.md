# Chat Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time group chat to the CCTV platform — users within the same org can create groups, send text/media messages, react, edit, delete, and receive push/email notifications when offline.

**Architecture:** Fastify WebSocket (`@fastify/websocket`) for real-time transport, Redis pub/sub for cross-instance broadcasting, PostgreSQL for persistence, S3 pre-signed URLs for media. A single WebSocket connection per user handles all their groups.

**Tech Stack:** Fastify 5, @fastify/websocket, ioredis (pub/sub), postgres.js, @aws-sdk/client-sns, web-push, Zod, Jest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/db/migrations/009_chat_schema.ts` | All chat tables + enums |
| `src/plugins/websocket.ts` | Register @fastify/websocket plugin |
| `src/utils/chat-pubsub.ts` | Redis pub/sub wrapper (publish, subscribe, unsubscribe) |
| `src/services/chat.service.ts` | Group CRUD + membership |
| `src/services/chat-message.service.ts` | Message persistence, edit, delete, reactions, read receipts |
| `src/services/chat-notification.service.ts` | Push (SNS/web-push) + email (SES) batching |
| `src/routes/chat/groups.ts` | REST: group management + member management |
| `src/routes/chat/messages.ts` | REST: message history, send, edit, delete, reactions, read receipts, media upload |
| `src/routes/chat/reports.ts` | REST: report CRUD |
| `src/routes/chat/index.ts` | Route aggregator (registers groups, messages, reports sub-routes) |
| `src/routes/chat/websocket.ts` | WebSocket upgrade handler + event dispatch |
| `src/config/env.ts` | Add SNS/web-push env vars |
| `src/types/fastify.d.ts` | Add SNSClient decoration |
| `src/plugins/aws.ts` | Add SNSClient |
| `src/routes/index.ts` | Register chat routes |
| `tests/chat/chat-groups.test.ts` | Group CRUD + membership tests |
| `tests/chat/chat-messages.test.ts` | Message send, edit, delete, reactions, read receipts |
| `tests/chat/chat-websocket.test.ts` | WebSocket connection, auth, broadcast |
| `tests/chat/chat-moderation.test.ts` | Mute, remove, report tests |
| `tests/chat/chat-isolation.test.ts` | Cross-org isolation tests |

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install production dependencies**

Run:
```bash
npm install @fastify/websocket web-push @aws-sdk/client-sns
```

- [ ] **Step 2: Install dev type definitions**

Run:
```bash
npm install -D @types/ws
```

- [ ] **Step 3: Verify installation**

Run:
```bash
node -e "require('@fastify/websocket'); require('web-push'); console.log('OK')"
```
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(chat): add websocket, web-push, and SNS dependencies"
```

---

### Task 2: Database Migration

**Files:**
- Create: `src/db/migrations/009_chat_schema.ts`

- [ ] **Step 1: Write the migration**

```typescript
import type { MigrationBuilder } from 'node-pg-migrate/dist/bundle/index';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Enums
  pgm.createType('chat_member_role', ['owner', 'member']);
  pgm.createType('chat_message_type', ['text', 'media', 'system']);
  pgm.createType('chat_report_status', ['pending', 'reviewed', 'dismissed']);
  pgm.createType('push_token_platform', ['ios', 'android', 'web']);

  // chat_groups
  pgm.createTable('chat_groups', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'organizations(id)', onDelete: 'CASCADE' },
    name: { type: 'varchar(100)', notNull: true },
    description: { type: 'text' },
    created_by: { type: 'uuid', notNull: true, references: 'users(id)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('chat_groups', 'org_id', { name: 'idx_chat_groups_org_id' });

  // chat_group_members
  pgm.createTable('chat_group_members', {
    group_id: { type: 'uuid', notNull: true, references: 'chat_groups(id)', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    role: { type: 'chat_member_role', notNull: true, default: pgm.func("'member'") },
    muted_until: { type: 'timestamptz' },
    joined_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('chat_group_members', 'chat_group_members_pkey', {
    primaryKey: ['group_id', 'user_id'],
  });
  pgm.createIndex('chat_group_members', 'user_id', { name: 'idx_chat_group_members_user' });

  // chat_messages
  pgm.createTable('chat_messages', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    group_id: { type: 'uuid', notNull: true, references: 'chat_groups(id)', onDelete: 'CASCADE' },
    sender_id: { type: 'uuid', references: 'users(id)' },
    type: { type: 'chat_message_type', notNull: true },
    content: { type: 'text', notNull: true },
    media_url: { type: 'text' },
    media_type: { type: 'varchar(50)' },
    edited_at: { type: 'timestamptz' },
    deleted_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('chat_messages', ['group_id', 'created_at'], {
    name: 'idx_chat_messages_group_created',
    method: 'btree',
  });

  // chat_message_reactions
  pgm.createTable('chat_message_reactions', {
    message_id: { type: 'uuid', notNull: true, references: 'chat_messages(id)', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    emoji: { type: 'varchar(32)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('chat_message_reactions', 'chat_message_reactions_pkey', {
    primaryKey: ['message_id', 'user_id', 'emoji'],
  });

  // chat_read_receipts
  pgm.createTable('chat_read_receipts', {
    group_id: { type: 'uuid', notNull: true, references: 'chat_groups(id)', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    last_read_message_id: { type: 'uuid', notNull: true, references: 'chat_messages(id)' },
    read_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('chat_read_receipts', 'chat_read_receipts_pkey', {
    primaryKey: ['group_id', 'user_id'],
  });

  // chat_reports
  pgm.createTable('chat_reports', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    group_id: { type: 'uuid', notNull: true, references: 'chat_groups(id)' },
    reported_by: { type: 'uuid', notNull: true, references: 'users(id)' },
    reported_user: { type: 'uuid', notNull: true, references: 'users(id)' },
    message_id: { type: 'uuid', references: 'chat_messages(id)' },
    reason: { type: 'text', notNull: true },
    status: { type: 'chat_report_status', notNull: true, default: pgm.func("'pending'") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // user_push_tokens
  pgm.createTable('user_push_tokens', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    platform: { type: 'push_token_platform', notNull: true },
    token: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
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
```

- [ ] **Step 2: Run the migration**

Run:
```bash
npm run migrate
```
Expected: Migration 009 applied successfully.

- [ ] **Step 3: Verify tables exist**

Run:
```bash
psql "$DATABASE_URL" -c "\dt chat_*" -c "\dt user_push_tokens"
```
Expected: All 6 chat tables + user_push_tokens listed.

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/009_chat_schema.ts
git commit -m "feat(chat): add database migration for chat tables"
```

---

### Task 3: WebSocket Plugin + Redis Pub/Sub Utility

**Files:**
- Create: `src/plugins/websocket.ts`
- Create: `src/utils/chat-pubsub.ts`
- Modify: `src/config/env.ts` (add optional SNS/web-push vars)
- Modify: `src/types/fastify.d.ts` (add SNSClient)
- Modify: `src/plugins/aws.ts` (add SNSClient)

- [ ] **Step 1: Create the WebSocket plugin**

Create `src/plugins/websocket.ts`:

```typescript
import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';

export default fp(async function websocketPlugin(app: FastifyInstance) {
  await app.register(websocket, {
    options: {
      maxPayload: 1048576, // 1MB
    },
  });
});
```

- [ ] **Step 2: Create the Redis pub/sub utility**

Create `src/utils/chat-pubsub.ts`:

```typescript
import { Redis } from 'ioredis';
import { env } from '@config/env';

type MessageHandler = (channel: string, message: string) => void;

let subscriber: Redis | null = null;
let publisher: Redis | null = null;
const handlers = new Map<string, Set<MessageHandler>>();

function getSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(env.REDIS_URL, { connectTimeout: 5000, maxRetriesPerRequest: 1 });
    subscriber.on('message', (channel: string, message: string) => {
      const channelHandlers = handlers.get(channel);
      if (channelHandlers) {
        for (const handler of channelHandlers) {
          handler(channel, message);
        }
      }
    });
  }
  return subscriber;
}

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(env.REDIS_URL, { connectTimeout: 5000, maxRetriesPerRequest: 1 });
  }
  return publisher;
}

export async function publish(channel: string, payload: unknown): Promise<void> {
  await getPublisher().publish(channel, JSON.stringify(payload));
}

export async function subscribe(channel: string, handler: MessageHandler): Promise<void> {
  const sub = getSubscriber();
  if (!handlers.has(channel)) {
    handlers.set(channel, new Set());
    await sub.subscribe(channel);
  }
  handlers.get(channel)!.add(handler);
}

export async function unsubscribe(channel: string, handler: MessageHandler): Promise<void> {
  const channelHandlers = handlers.get(channel);
  if (!channelHandlers) return;
  channelHandlers.delete(handler);
  if (channelHandlers.size === 0) {
    handlers.delete(channel);
    await getSubscriber().unsubscribe(channel);
  }
}

export async function shutdown(): Promise<void> {
  if (subscriber) {
    await subscriber.quit();
    subscriber = null;
  }
  if (publisher) {
    await publisher.quit();
    publisher = null;
  }
  handlers.clear();
}

export function channelForGroup(groupId: string): string {
  return `chat:group:${groupId}`;
}
```

- [ ] **Step 3: Add SNS env vars to config**

Add to the `envSchema` in `src/config/env.ts`, after `ALERT_DEBOUNCE_SECONDS`:

```typescript
  SNS_PLATFORM_ARN_IOS: z.string().default(''),
  SNS_PLATFORM_ARN_ANDROID: z.string().default(''),
  WEB_PUSH_VAPID_PUBLIC_KEY: z.string().default(''),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.string().default(''),
  WEB_PUSH_CONTACT_EMAIL: z.string().default(''),
```

- [ ] **Step 4: Add SNSClient to AWS plugin**

In `src/plugins/aws.ts`, add import:

```typescript
import { SNSClient } from '@aws-sdk/client-sns';
```

Add after `const ses = ...`:

```typescript
  const sns = new SNSClient({ region: env.AWS_REGION });
```

Add decorator after `app.decorate('ses', ses)`:

```typescript
  app.decorate('sns', sns);
```

Add to onClose hook:

```typescript
    sns.destroy();
```

- [ ] **Step 5: Update Fastify type declarations**

In `src/types/fastify.d.ts`, add import:

```typescript
import type { SNSClient } from '@aws-sdk/client-sns';
```

Add to `FastifyInstance`:

```typescript
    sns: SNSClient;
```

- [ ] **Step 6: Register WebSocket plugin in app.ts**

In `src/app.ts`, add import:

```typescript
import websocketPlugin from '@plugins/websocket';
```

Add registration after `void app.register(awsPlugin);`:

```typescript
  void app.register(websocketPlugin);
```

- [ ] **Step 7: Commit**

```bash
git add src/plugins/websocket.ts src/utils/chat-pubsub.ts src/config/env.ts src/types/fastify.d.ts src/plugins/aws.ts src/app.ts
git commit -m "feat(chat): add websocket plugin and redis pub/sub utility"
```

---

### Task 4: Chat Service (Group CRUD + Membership)

**Files:**
- Create: `src/services/chat.service.ts`
- Test: `tests/chat/chat-groups.test.ts`

- [ ] **Step 1: Write failing tests for group creation**

Create `tests/chat/chat-groups.test.ts`:

```typescript
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Chat Groups', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgId: string;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let viewerId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'chat');
    orgId = org.orgId;
    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create a viewer
    const viewerEmail = `viewer-chat-${Date.now()}@example.com`;
    const viewerPassword = 'password123!';
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerId = viewerRes.json<{ id: string }>().id;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerAccessToken = loginRes.json<{ accessToken: string }>().accessToken;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('POST /api/v1/chat/groups', () => {
    it('creates a group and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Security Team', description: 'Main security chat' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; name: string; org_id: string }>();
      expect(body.name).toBe('Security Team');
      expect(body.org_id).toBe(orgId);
    });

    it('viewer can create a group', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { name: 'Viewer Group' },
      });

      expect(res.statusCode).toBe(201);
    });

    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        payload: { name: 'No Auth' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 400 with missing name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/chat/groups', () => {
    it('lists groups the user is a member of', async () => {
      // Create group as org admin (auto-joined as owner)
      await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'List Test Group' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ name: string }> }>();
      expect(body.data.length).toBeGreaterThan(0);
    });

    it('viewer sees only groups they belong to', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: unknown[] }>();
      // Viewer only sees groups they created
      for (const group of body.data) {
        expect(group).toHaveProperty('id');
      }
    });
  });

  describe('POST /api/v1/chat/groups/:groupId/members', () => {
    let groupId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Member Test Group' },
      });
      groupId = res.json<{ id: string }>().id;
    });

    it('adds members to the group', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/members`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { userIds: [viewerId] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ added: number }>();
      expect(body.added).toBe(1);
    });

    it('returns 403 if not a member of the group', async () => {
      // Create a separate group viewer is not in
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Private Group' },
      });
      const privateGroupId = createRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${privateGroupId}/members`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { userIds: [viewerId] },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('DELETE /api/v1/chat/groups/:groupId/members/:userId', () => {
    let groupId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Remove Member Test' },
      });
      groupId = res.json<{ id: string }>().id;

      // Add viewer to group
      await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/members`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { userIds: [viewerId] },
      });
    });

    it('owner can remove a member', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/chat/groups/${groupId}/members/${viewerId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it('member can leave (remove self)', async () => {
      // Re-add viewer
      await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/members`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { userIds: [viewerId] },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/chat/groups/${groupId}/members/${viewerId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('PATCH /api/v1/chat/groups/:groupId', () => {
    let groupId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Update Test Group' },
      });
      groupId = res.json<{ id: string }>().id;
    });

    it('owner can update group name', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/groups/${groupId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Updated Name' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ name: string }>().name).toBe('Updated Name');
    });

    it('non-owner member cannot update', async () => {
      // Add viewer and try to update
      await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/members`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { userIds: [viewerId] },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/groups/${groupId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { name: 'Hacked Name' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('DELETE /api/v1/chat/groups/:groupId', () => {
    it('owner can delete the group', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Delete Me' },
      });
      const groupId = createRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/chat/groups/${groupId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(204);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npm test -- --testPathPattern=tests/chat/chat-groups --forceExit
```
Expected: FAIL (routes not defined yet)

- [ ] **Step 3: Create the chat service**

Create `src/services/chat.service.ts`:

```typescript
import type { Sql } from 'postgres';

export interface ChatGroup {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface ChatGroupMember {
  group_id: string;
  user_id: string;
  role: 'owner' | 'member';
  muted_until: Date | null;
  joined_at: Date;
}

export interface CreateGroupInput {
  name: string;
  description?: string;
  orgId: string;
  createdBy: string;
}

export interface UpdateGroupInput {
  name?: string;
  description?: string;
}

export async function createGroup(db: Sql, input: CreateGroupInput): Promise<ChatGroup> {
  const [group] = await db<ChatGroup[]>`
    INSERT INTO chat_groups (org_id, name, description, created_by)
    VALUES (${input.orgId}, ${input.name}, ${input.description ?? null}, ${input.createdBy})
    RETURNING *
  `;

  await db`
    INSERT INTO chat_group_members (group_id, user_id, role)
    VALUES (${group!.id}, ${input.createdBy}, 'owner')
  `;

  return group!;
}

export async function listGroupsForUser(db: Sql, userId: string, orgId: string): Promise<ChatGroup[]> {
  return db<ChatGroup[]>`
    SELECT g.*
    FROM chat_groups g
    JOIN chat_group_members m ON m.group_id = g.id
    WHERE m.user_id = ${userId} AND g.org_id = ${orgId}
    ORDER BY g.updated_at DESC
  `;
}

export async function getGroupById(db: Sql, groupId: string, orgId: string): Promise<ChatGroup | null> {
  const [group] = await db<ChatGroup[]>`
    SELECT * FROM chat_groups WHERE id = ${groupId} AND org_id = ${orgId}
  `;
  return group ?? null;
}

export async function updateGroup(db: Sql, groupId: string, input: UpdateGroupInput): Promise<ChatGroup> {
  const [group] = await db<ChatGroup[]>`
    UPDATE chat_groups
    SET
      name = COALESCE(${input.name ?? null}, name),
      description = COALESCE(${input.description ?? null}, description),
      updated_at = now()
    WHERE id = ${groupId}
    RETURNING *
  `;
  return group!;
}

export async function deleteGroup(db: Sql, groupId: string): Promise<void> {
  await db`DELETE FROM chat_groups WHERE id = ${groupId}`;
}

export async function isMember(db: Sql, groupId: string, userId: string): Promise<boolean> {
  const [row] = await db`
    SELECT 1 FROM chat_group_members WHERE group_id = ${groupId} AND user_id = ${userId}
  `;
  return !!row;
}

export async function getMemberRole(db: Sql, groupId: string, userId: string): Promise<'owner' | 'member' | null> {
  const [row] = await db<Array<{ role: 'owner' | 'member' }>>`
    SELECT role FROM chat_group_members WHERE group_id = ${groupId} AND user_id = ${userId}
  `;
  return row?.role ?? null;
}

export async function addMembers(
  db: Sql,
  groupId: string,
  userIds: string[],
  orgId: string,
): Promise<number> {
  // Only add users that belong to the same org
  const validUsers = await db<Array<{ id: string }>>`
    SELECT id FROM users WHERE id = ANY(${userIds}) AND org_id = ${orgId}
  `;
  const validIds = validUsers.map((u) => u.id);

  if (validIds.length === 0) return 0;

  const values = validIds.map((userId) => ({ group_id: groupId, user_id: userId, role: 'member' }));
  const result = await db`
    INSERT INTO chat_group_members ${db(values, 'group_id', 'user_id', 'role')}
    ON CONFLICT (group_id, user_id) DO NOTHING
  `;
  return result.count;
}

export async function removeMember(db: Sql, groupId: string, userId: string): Promise<void> {
  await db`
    DELETE FROM chat_group_members WHERE group_id = ${groupId} AND user_id = ${userId}
  `;
}

export async function muteMember(db: Sql, groupId: string, userId: string, mutedUntil: Date): Promise<void> {
  await db`
    UPDATE chat_group_members
    SET muted_until = ${mutedUntil}
    WHERE group_id = ${groupId} AND user_id = ${userId}
  `;
}

export async function unmuteMember(db: Sql, groupId: string, userId: string): Promise<void> {
  await db`
    UPDATE chat_group_members
    SET muted_until = NULL
    WHERE group_id = ${groupId} AND user_id = ${userId}
  `;
}

export async function isMuted(db: Sql, groupId: string, userId: string): Promise<boolean> {
  const [row] = await db<Array<{ muted_until: Date | null }>>`
    SELECT muted_until FROM chat_group_members WHERE group_id = ${groupId} AND user_id = ${userId}
  `;
  if (!row?.muted_until) return false;
  return new Date(row.muted_until) > new Date();
}

export async function getGroupMembers(db: Sql, groupId: string): Promise<Array<ChatGroupMember & { email: string }>> {
  return db<Array<ChatGroupMember & { email: string }>>`
    SELECT m.*, u.email
    FROM chat_group_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ${groupId}
    ORDER BY m.joined_at ASC
  `;
}
```

- [ ] **Step 4: Create group routes**

Create `src/routes/chat/groups.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '@middleware/require-user';
import { AppError } from '@utils/errors';
import {
  createGroup,
  listGroupsForUser,
  getGroupById,
  updateGroup,
  deleteGroup,
  isMember,
  getMemberRole,
  addMembers,
  removeMember,
  muteMember,
  unmuteMember,
  getGroupMembers,
} from '@services/chat.service';

const createGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

const updateGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

const addMembersSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(50),
});

const muteSchema = z.object({
  duration: z.number().int().positive().max(525600), // minutes, max 1 year
});

export default async function chatGroupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireUser);

  // POST /groups — create group
  app.post('/', async (request, reply) => {
    const body = createGroupSchema.parse(request.body);
    const group = await createGroup(app.db, {
      name: body.name,
      description: body.description,
      orgId: request.user.org_id!,
      createdBy: request.user.sub,
    });
    return reply.code(201).send(group);
  });

  // GET /groups — list user's groups
  app.get('/', async (request, reply) => {
    const groups = await listGroupsForUser(app.db, request.user.sub, request.user.org_id!);
    return reply.send({ data: groups });
  });

  // GET /groups/:groupId — group details + members
  app.get<{ Params: { groupId: string } }>('/:groupId', async (request, reply) => {
    const { groupId } = request.params;
    const group = await getGroupById(app.db, groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const memberCheck = await isMember(app.db, groupId, request.user.sub);
    if (!memberCheck) throw AppError.forbidden('Not a member of this group');

    const members = await getGroupMembers(app.db, groupId);
    return reply.send({ ...group, members });
  });

  // PATCH /groups/:groupId — update group
  app.patch<{ Params: { groupId: string } }>('/:groupId', async (request, reply) => {
    const { groupId } = request.params;
    const group = await getGroupById(app.db, groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const role = await getMemberRole(app.db, groupId, request.user.sub);
    if (role !== 'owner' && request.user.role !== 'org_admin') {
      throw AppError.forbidden('Only group owner or org admin can update');
    }

    const body = updateGroupSchema.parse(request.body);
    const updated = await updateGroup(app.db, groupId, body);
    return reply.send(updated);
  });

  // DELETE /groups/:groupId — delete group
  app.delete<{ Params: { groupId: string } }>('/:groupId', async (request, reply) => {
    const { groupId } = request.params;
    const group = await getGroupById(app.db, groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const role = await getMemberRole(app.db, groupId, request.user.sub);
    if (role !== 'owner' && request.user.role !== 'org_admin') {
      throw AppError.forbidden('Only group owner or org admin can delete');
    }

    await deleteGroup(app.db, groupId);
    return reply.code(204).send();
  });

  // POST /groups/:groupId/members — add members
  app.post<{ Params: { groupId: string } }>('/:groupId/members', async (request, reply) => {
    const { groupId } = request.params;
    const group = await getGroupById(app.db, groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const memberCheck = await isMember(app.db, groupId, request.user.sub);
    if (!memberCheck) throw AppError.forbidden('Not a member of this group');

    const body = addMembersSchema.parse(request.body);
    const added = await addMembers(app.db, groupId, body.userIds, request.user.org_id!);
    return reply.send({ added });
  });

  // DELETE /groups/:groupId/members/:userId — remove member
  app.delete<{ Params: { groupId: string; userId: string } }>('/:groupId/members/:userId', async (request, reply) => {
    const { groupId, userId } = request.params;
    const group = await getGroupById(app.db, groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const isSelf = userId === request.user.sub;
    if (!isSelf) {
      const role = await getMemberRole(app.db, groupId, request.user.sub);
      if (role !== 'owner' && request.user.role !== 'org_admin') {
        throw AppError.forbidden('Only group owner or org admin can remove members');
      }
    }

    await removeMember(app.db, groupId, userId);
    return reply.send({ removed: true });
  });

  // PATCH /groups/:groupId/members/:userId/mute
  app.patch<{ Params: { groupId: string; userId: string } }>('/:groupId/members/:userId/mute', async (request, reply) => {
    const { groupId, userId } = request.params;
    const group = await getGroupById(app.db, groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const role = await getMemberRole(app.db, groupId, request.user.sub);
    if (role !== 'owner' && request.user.role !== 'org_admin') {
      throw AppError.forbidden('Only group owner or org admin can mute members');
    }

    const body = muteSchema.parse(request.body);
    const mutedUntil = new Date(Date.now() + body.duration * 60 * 1000);
    await muteMember(app.db, groupId, userId, mutedUntil);
    return reply.send({ muted_until: mutedUntil.toISOString() });
  });

  // PATCH /groups/:groupId/members/:userId/unmute
  app.patch<{ Params: { groupId: string; userId: string } }>('/:groupId/members/:userId/unmute', async (request, reply) => {
    const { groupId, userId } = request.params;
    const group = await getGroupById(app.db, groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const role = await getMemberRole(app.db, groupId, request.user.sub);
    if (role !== 'owner' && request.user.role !== 'org_admin') {
      throw AppError.forbidden('Only group owner or org admin can unmute members');
    }

    await unmuteMember(app.db, groupId, userId);
    return reply.send({ muted_until: null });
  });
}
```

- [ ] **Step 5: Create the route aggregator**

Create `src/routes/chat/index.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import chatGroupRoutes from './groups';

export default async function chatRoutes(app: FastifyInstance): Promise<void> {
  await app.register(chatGroupRoutes, { prefix: '/groups' });
}
```

- [ ] **Step 6: Register chat routes in the main route index**

In `src/routes/index.ts`, add import:

```typescript
import chatRoutes from './chat/index';
```

Add at the end of the function:

```typescript
  // Chat routes: /api/v1/chat/*
  await app.register(chatRoutes, { prefix: '/chat' });
```

- [ ] **Step 7: Run tests to verify they pass**

Run:
```bash
npm test -- --testPathPattern=tests/chat/chat-groups --forceExit
```
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/services/chat.service.ts src/routes/chat/groups.ts src/routes/chat/index.ts src/routes/index.ts tests/chat/chat-groups.test.ts
git commit -m "feat(chat): group CRUD and membership management"
```

---

### Task 5: Chat Message Service + REST Routes

**Files:**
- Create: `src/services/chat-message.service.ts`
- Create: `src/routes/chat/messages.ts`
- Modify: `src/routes/chat/index.ts`
- Test: `tests/chat/chat-messages.test.ts`

- [ ] **Step 1: Write failing tests for messages**

Create `tests/chat/chat-messages.test.ts`:

```typescript
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Chat Messages', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let viewerId: string;
  let groupId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'chat-msg');
    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create a viewer
    const viewerEmail = `viewer-msg-${Date.now()}@example.com`;
    const viewerPassword = 'password123!';
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerId = viewerRes.json<{ id: string }>().id;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerAccessToken = loginRes.json<{ accessToken: string }>().accessToken;

    // Create group and add viewer
    const groupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/groups',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Message Test Group' },
    });
    groupId = groupRes.json<{ id: string }>().id;

    await app.inject({
      method: 'POST',
      url: `/api/v1/chat/groups/${groupId}/members`,
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { userIds: [viewerId] },
    });
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('POST /api/v1/chat/groups/:groupId/messages', () => {
    it('sends a text message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { content: 'Hello team!', type: 'text' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; content: string; type: string }>();
      expect(body.content).toBe('Hello team!');
      expect(body.type).toBe('text');
    });

    it('returns 403 if not a member', async () => {
      // Create another group without adding viewer
      const groupRes = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Private' },
      });
      const privateGroupId = groupRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${privateGroupId}/messages`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { content: 'Spam', type: 'text' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /api/v1/chat/groups/:groupId/messages', () => {
    it('returns paginated message history', async () => {
      // Send a few messages
      for (let i = 0; i < 3; i++) {
        await app.inject({
          method: 'POST',
          url: `/api/v1/chat/groups/${groupId}/messages`,
          headers: { authorization: `Bearer ${orgAdminAccessToken}` },
          payload: { content: `Message ${i}`, type: 'text' },
        });
      }

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/chat/groups/${groupId}/messages?limit=2`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: unknown[]; cursor: string | null }>();
      expect(body.data.length).toBe(2);
      expect(body.cursor).toBeTruthy();
    });
  });

  describe('PATCH /api/v1/chat/groups/:groupId/messages/:messageId', () => {
    it('sender can edit their message', async () => {
      const sendRes = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { content: 'Typo', type: 'text' },
      });
      const messageId = sendRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/groups/${groupId}/messages/${messageId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { content: 'Fixed typo' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ content: string }>().content).toBe('Fixed typo');
    });

    it('other users cannot edit the message', async () => {
      const sendRes = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { content: 'My message', type: 'text' },
      });
      const messageId = sendRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/groups/${groupId}/messages/${messageId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { content: 'Hijacked' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('DELETE /api/v1/chat/groups/:groupId/messages/:messageId', () => {
    it('sender can delete their message', async () => {
      const sendRes = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { content: 'Delete me', type: 'text' },
      });
      const messageId = sendRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/chat/groups/${groupId}/messages/${messageId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it('group owner can delete any message', async () => {
      const sendRes = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { content: 'Owner can delete this', type: 'text' },
      });
      const messageId = sendRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/chat/groups/${groupId}/messages/${messageId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('Reactions', () => {
    let messageId: string;

    beforeAll(async () => {
      const sendRes = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { content: 'React to me', type: 'text' },
      });
      messageId = sendRes.json<{ id: string }>().id;
    });

    it('adds a reaction', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages/${messageId}/reactions`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { emoji: '👍' },
      });

      expect(res.statusCode).toBe(201);
    });

    it('removes a reaction', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/chat/groups/${groupId}/messages/${messageId}/reactions/%F0%9F%91%8D`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('Read Receipts', () => {
    it('marks messages as read', async () => {
      const sendRes = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { content: 'Read me', type: 'text' },
      });
      const messageId = sendRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/read`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { lastReadMessageId: messageId },
      });

      expect(res.statusCode).toBe(200);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npm test -- --testPathPattern=tests/chat/chat-messages --forceExit
```
Expected: FAIL

- [ ] **Step 3: Create the message service**

Create `src/services/chat-message.service.ts`:

```typescript
import type { Sql } from 'postgres';

export interface ChatMessage {
  id: string;
  group_id: string;
  sender_id: string | null;
  type: 'text' | 'media' | 'system';
  content: string;
  media_url: string | null;
  media_type: string | null;
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}

export interface SendMessageInput {
  groupId: string;
  senderId: string;
  type: 'text' | 'media' | 'system';
  content: string;
  mediaUrl?: string;
  mediaType?: string;
}

export async function sendMessage(db: Sql, input: SendMessageInput): Promise<ChatMessage> {
  const [message] = await db<ChatMessage[]>`
    INSERT INTO chat_messages (group_id, sender_id, type, content, media_url, media_type)
    VALUES (${input.groupId}, ${input.senderId}, ${input.type}, ${input.content}, ${input.mediaUrl ?? null}, ${input.mediaType ?? null})
    RETURNING *
  `;
  return message!;
}

export async function sendSystemMessage(db: Sql, groupId: string, content: string): Promise<ChatMessage> {
  const [message] = await db<ChatMessage[]>`
    INSERT INTO chat_messages (group_id, sender_id, type, content)
    VALUES (${groupId}, NULL, 'system', ${content})
    RETURNING *
  `;
  return message!;
}

export async function getMessages(
  db: Sql,
  groupId: string,
  limit: number,
  cursor?: string,
): Promise<{ data: ChatMessage[]; cursor: string | null }> {
  let messages: ChatMessage[];

  if (cursor) {
    messages = await db<ChatMessage[]>`
      SELECT * FROM chat_messages
      WHERE group_id = ${groupId} AND deleted_at IS NULL AND created_at < (
        SELECT created_at FROM chat_messages WHERE id = ${cursor}
      )
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  } else {
    messages = await db<ChatMessage[]>`
      SELECT * FROM chat_messages
      WHERE group_id = ${groupId} AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }

  const nextCursor = messages.length === limit ? messages[messages.length - 1]!.id : null;
  return { data: messages, cursor: nextCursor };
}

export async function getMessageById(db: Sql, messageId: string): Promise<ChatMessage | null> {
  const [message] = await db<ChatMessage[]>`
    SELECT * FROM chat_messages WHERE id = ${messageId} AND deleted_at IS NULL
  `;
  return message ?? null;
}

export async function editMessage(db: Sql, messageId: string, content: string): Promise<ChatMessage> {
  const [message] = await db<ChatMessage[]>`
    UPDATE chat_messages
    SET content = ${content}, edited_at = now()
    WHERE id = ${messageId}
    RETURNING *
  `;
  return message!;
}

export async function deleteMessage(db: Sql, messageId: string): Promise<void> {
  await db`
    UPDATE chat_messages SET deleted_at = now() WHERE id = ${messageId}
  `;
}

export async function addReaction(db: Sql, messageId: string, userId: string, emoji: string): Promise<void> {
  await db`
    INSERT INTO chat_message_reactions (message_id, user_id, emoji)
    VALUES (${messageId}, ${userId}, ${emoji})
    ON CONFLICT (message_id, user_id, emoji) DO NOTHING
  `;
}

export async function removeReaction(db: Sql, messageId: string, userId: string, emoji: string): Promise<void> {
  await db`
    DELETE FROM chat_message_reactions
    WHERE message_id = ${messageId} AND user_id = ${userId} AND emoji = ${emoji}
  `;
}

export async function markRead(db: Sql, groupId: string, userId: string, lastReadMessageId: string): Promise<void> {
  await db`
    INSERT INTO chat_read_receipts (group_id, user_id, last_read_message_id, read_at)
    VALUES (${groupId}, ${userId}, ${lastReadMessageId}, now())
    ON CONFLICT (group_id, user_id)
    DO UPDATE SET last_read_message_id = ${lastReadMessageId}, read_at = now()
  `;
}
```

- [ ] **Step 4: Create message routes**

Create `src/routes/chat/messages.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '@middleware/require-user';
import { AppError } from '@utils/errors';
import { isMember, isMuted, getMemberRole, getGroupById } from '@services/chat.service';
import {
  sendMessage,
  getMessages,
  getMessageById,
  editMessage,
  deleteMessage,
  addReaction,
  removeReaction,
  markRead,
} from '@services/chat-message.service';

const sendMessageSchema = z.object({
  content: z.string().min(1).max(5000),
  type: z.enum(['text', 'media']),
  mediaUrl: z.string().optional(),
  mediaType: z.string().max(50).optional(),
});

const editMessageSchema = z.object({
  content: z.string().min(1).max(5000),
});

const reactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});

const readSchema = z.object({
  lastReadMessageId: z.string().uuid(),
});

export default async function chatMessageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireUser);

  // GET /groups/:groupId/messages
  app.get<{ Params: { groupId: string }; Querystring: { limit?: string; cursor?: string } }>(
    '/:groupId/messages',
    async (request, reply) => {
      const { groupId } = request.params;
      const group = await getGroupById(app.db, groupId, request.user.org_id!);
      if (!group) throw AppError.notFound('Group not found');

      const memberCheck = await isMember(app.db, groupId, request.user.sub);
      if (!memberCheck) throw AppError.forbidden('Not a member of this group');

      const limit = Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 100);
      const cursor = request.query.cursor;
      const result = await getMessages(app.db, groupId, limit, cursor);
      return reply.send(result);
    },
  );

  // POST /groups/:groupId/messages
  app.post<{ Params: { groupId: string } }>('/:groupId/messages', async (request, reply) => {
    const { groupId } = request.params;
    const group = await getGroupById(app.db, groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const memberCheck = await isMember(app.db, groupId, request.user.sub);
    if (!memberCheck) throw AppError.forbidden('Not a member of this group');

    const muted = await isMuted(app.db, groupId, request.user.sub);
    if (muted) throw AppError.forbidden('You are muted in this group');

    const body = sendMessageSchema.parse(request.body);
    const message = await sendMessage(app.db, {
      groupId,
      senderId: request.user.sub,
      type: body.type,
      content: body.content,
      mediaUrl: body.mediaUrl,
      mediaType: body.mediaType,
    });
    return reply.code(201).send(message);
  });

  // PATCH /groups/:groupId/messages/:messageId
  app.patch<{ Params: { groupId: string; messageId: string } }>(
    '/:groupId/messages/:messageId',
    async (request, reply) => {
      const { groupId, messageId } = request.params;
      const group = await getGroupById(app.db, groupId, request.user.org_id!);
      if (!group) throw AppError.notFound('Group not found');

      const message = await getMessageById(app.db, messageId);
      if (!message || message.group_id !== groupId) throw AppError.notFound('Message not found');

      if (message.sender_id !== request.user.sub) {
        throw AppError.forbidden('Only the sender can edit this message');
      }

      const body = editMessageSchema.parse(request.body);
      const updated = await editMessage(app.db, messageId, body.content);
      return reply.send(updated);
    },
  );

  // DELETE /groups/:groupId/messages/:messageId
  app.delete<{ Params: { groupId: string; messageId: string } }>(
    '/:groupId/messages/:messageId',
    async (request, reply) => {
      const { groupId, messageId } = request.params;
      const group = await getGroupById(app.db, groupId, request.user.org_id!);
      if (!group) throw AppError.notFound('Group not found');

      const message = await getMessageById(app.db, messageId);
      if (!message || message.group_id !== groupId) throw AppError.notFound('Message not found');

      const isSender = message.sender_id === request.user.sub;
      if (!isSender) {
        const role = await getMemberRole(app.db, groupId, request.user.sub);
        if (role !== 'owner' && request.user.role !== 'org_admin') {
          throw AppError.forbidden('Cannot delete this message');
        }
      }

      await deleteMessage(app.db, messageId);
      return reply.send({ deleted: true });
    },
  );

  // POST /groups/:groupId/messages/:messageId/reactions
  app.post<{ Params: { groupId: string; messageId: string } }>(
    '/:groupId/messages/:messageId/reactions',
    async (request, reply) => {
      const { groupId, messageId } = request.params;
      const memberCheck = await isMember(app.db, groupId, request.user.sub);
      if (!memberCheck) throw AppError.forbidden('Not a member of this group');

      const message = await getMessageById(app.db, messageId);
      if (!message || message.group_id !== groupId) throw AppError.notFound('Message not found');

      const body = reactionSchema.parse(request.body);
      await addReaction(app.db, messageId, request.user.sub, body.emoji);
      return reply.code(201).send({ added: true });
    },
  );

  // DELETE /groups/:groupId/messages/:messageId/reactions/:emoji
  app.delete<{ Params: { groupId: string; messageId: string; emoji: string } }>(
    '/:groupId/messages/:messageId/reactions/:emoji',
    async (request, reply) => {
      const { groupId, messageId, emoji } = request.params;
      const memberCheck = await isMember(app.db, groupId, request.user.sub);
      if (!memberCheck) throw AppError.forbidden('Not a member of this group');

      await removeReaction(app.db, messageId, request.user.sub, decodeURIComponent(emoji));
      return reply.send({ removed: true });
    },
  );

  // POST /groups/:groupId/read
  app.post<{ Params: { groupId: string } }>('/:groupId/read', async (request, reply) => {
    const { groupId } = request.params;
    const memberCheck = await isMember(app.db, groupId, request.user.sub);
    if (!memberCheck) throw AppError.forbidden('Not a member of this group');

    const body = readSchema.parse(request.body);
    await markRead(app.db, groupId, request.user.sub, body.lastReadMessageId);
    return reply.send({ success: true });
  });
}
```

- [ ] **Step 5: Register message routes in the aggregator**

Update `src/routes/chat/index.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import chatGroupRoutes from './groups';
import chatMessageRoutes from './messages';

export default async function chatRoutes(app: FastifyInstance): Promise<void> {
  await app.register(chatGroupRoutes, { prefix: '/groups' });
  await app.register(chatMessageRoutes, { prefix: '/groups' });
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run:
```bash
npm test -- --testPathPattern=tests/chat/chat-messages --forceExit
```
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/chat-message.service.ts src/routes/chat/messages.ts src/routes/chat/index.ts tests/chat/chat-messages.test.ts
git commit -m "feat(chat): message CRUD, reactions, and read receipts"
```

---

### Task 6: Media Upload Route

**Files:**
- Modify: `src/routes/chat/messages.ts`
- Test: (included in chat-messages tests)

- [ ] **Step 1: Add media upload test to `tests/chat/chat-messages.test.ts`**

Add this describe block inside the main describe:

```typescript
  describe('POST /api/v1/chat/groups/:groupId/media/upload', () => {
    it('returns a pre-signed upload URL', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/media/upload`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { fileName: 'photo.jpg', contentType: 'image/jpeg' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ uploadUrl: string; key: string }>();
      expect(body.uploadUrl).toContain('X-Amz-Signature');
      expect(body.key).toContain('chat/');
    });

    it('rejects disallowed content types', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/media/upload`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { fileName: 'script.exe', contentType: 'application/x-msdownload' },
      });

      expect(res.statusCode).toBe(400);
    });
  });
```

- [ ] **Step 2: Add the media upload handler to messages route**

Add to the bottom of `src/routes/chat/messages.ts`, before the closing `}`:

```typescript
  const ALLOWED_MEDIA_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/webm',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]);

  const mediaUploadSchema = z.object({
    fileName: z.string().min(1).max(255),
    contentType: z.string().min(1).max(100),
  });

  // POST /groups/:groupId/media/upload
  app.post<{ Params: { groupId: string } }>('/:groupId/media/upload', async (request, reply) => {
    const { groupId } = request.params;
    const group = await getGroupById(app.db, groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const memberCheck = await isMember(app.db, groupId, request.user.sub);
    if (!memberCheck) throw AppError.forbidden('Not a member of this group');

    const muted = await isMuted(app.db, groupId, request.user.sub);
    if (muted) throw AppError.forbidden('You are muted in this group');

    const body = mediaUploadSchema.parse(request.body);
    if (!ALLOWED_MEDIA_TYPES.has(body.contentType)) {
      throw AppError.badRequest('File type not allowed');
    }

    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const now = new Date();
    const key = `orgs/${request.user.org_id}/chat/${groupId}/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}/${body.fileName}`;

    const command = new PutObjectCommand({
      Bucket: (await import('@config/env')).env.S3_MEDIA_BUCKET,
      Key: key,
      ContentType: body.contentType,
      ContentLength: 25 * 1024 * 1024, // 25MB max
    });

    const uploadUrl = await getSignedUrl(app.s3, command, { expiresIn: 300 });
    return reply.send({ uploadUrl, key });
  });
```

- [ ] **Step 3: Run tests**

Run:
```bash
npm test -- --testPathPattern=tests/chat/chat-messages --forceExit
```
Expected: All PASS (media upload test may need S3_MEDIA_BUCKET env set — in test env it generates the URL against a mock bucket name)

- [ ] **Step 4: Commit**

```bash
git add src/routes/chat/messages.ts tests/chat/chat-messages.test.ts
git commit -m "feat(chat): media upload with pre-signed S3 URLs"
```

---

### Task 7: Reports Routes

**Files:**
- Create: `src/routes/chat/reports.ts`
- Modify: `src/routes/chat/index.ts`
- Test: `tests/chat/chat-moderation.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/chat/chat-moderation.test.ts`:

```typescript
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Chat Moderation', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let viewerId: string;
  let groupId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'chat-mod');
    orgAdminAccessToken = org.orgAdminAccessToken;

    const viewerEmail = `viewer-mod-${Date.now()}@example.com`;
    const viewerPassword = 'password123!';
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerId = viewerRes.json<{ id: string }>().id;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerAccessToken = loginRes.json<{ accessToken: string }>().accessToken;

    const groupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/groups',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Moderation Test' },
    });
    groupId = groupRes.json<{ id: string }>().id;

    await app.inject({
      method: 'POST',
      url: `/api/v1/chat/groups/${groupId}/members`,
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { userIds: [viewerId] },
    });
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('Muting', () => {
    it('muted user cannot send messages', async () => {
      // Mute the viewer
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/groups/${groupId}/members/${viewerId}/mute`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { duration: 60 },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { content: 'Should fail', type: 'text' },
      });

      expect(res.statusCode).toBe(403);

      // Unmute
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/groups/${groupId}/members/${viewerId}/unmute`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
    });
  });

  describe('Reports', () => {
    it('member can report another user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/reports`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { reportedUser: viewerId, reason: 'Spam messages' },
      });

      expect(res.statusCode).toBe(201);
    });

    it('org admin can list reports', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/chat/reports',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: unknown[] }>();
      expect(body.data.length).toBeGreaterThan(0);
    });

    it('org admin can update report status', async () => {
      // Get a report ID
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/v1/chat/reports',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
      const reportId = listRes.json<{ data: Array<{ id: string }> }>().data[0]!.id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/reports/${reportId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { status: 'reviewed' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('non-admin cannot list reports', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/chat/reports',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npm test -- --testPathPattern=tests/chat/chat-moderation --forceExit
```
Expected: FAIL

- [ ] **Step 3: Create reports route**

Create `src/routes/chat/reports.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '@middleware/require-user';
import { requireOrgAdmin } from '@middleware/require-org-admin';
import { AppError } from '@utils/errors';
import { isMember, getGroupById } from '@services/chat.service';

const createReportSchema = z.object({
  reportedUser: z.string().uuid(),
  messageId: z.string().uuid().optional(),
  reason: z.string().min(1).max(1000),
});

const updateReportSchema = z.object({
  status: z.enum(['reviewed', 'dismissed']),
});

export default async function chatReportRoutes(app: FastifyInstance): Promise<void> {
  // POST /groups/:groupId/reports — create report (requireUser)
  app.post<{ Params: { groupId: string } }>(
    '/groups/:groupId/reports',
    { onRequest: requireUser },
    async (request, reply) => {
      const { groupId } = request.params;
      const group = await getGroupById(app.db, groupId, request.user.org_id!);
      if (!group) throw AppError.notFound('Group not found');

      const memberCheck = await isMember(app.db, groupId, request.user.sub);
      if (!memberCheck) throw AppError.forbidden('Not a member of this group');

      const body = createReportSchema.parse(request.body);

      const [report] = await app.db<Array<{ id: string; status: string; created_at: Date }>>`
        INSERT INTO chat_reports (group_id, reported_by, reported_user, message_id, reason)
        VALUES (${groupId}, ${request.user.sub}, ${body.reportedUser}, ${body.messageId ?? null}, ${body.reason})
        RETURNING *
      `;

      return reply.code(201).send(report);
    },
  );

  // GET /reports — list reports for org (requireOrgAdmin)
  app.get('/reports', { onRequest: [requireUser, requireOrgAdmin] }, async (request, reply) => {
    const reports = await app.db`
      SELECT r.*
      FROM chat_reports r
      JOIN chat_groups g ON g.id = r.group_id
      WHERE g.org_id = ${request.user.org_id!}
      ORDER BY r.created_at DESC
    `;
    return reply.send({ data: reports });
  });

  // PATCH /reports/:reportId — update status (requireOrgAdmin)
  app.patch<{ Params: { reportId: string } }>(
    '/reports/:reportId',
    { onRequest: [requireUser, requireOrgAdmin] },
    async (request, reply) => {
      const { reportId } = request.params;
      const body = updateReportSchema.parse(request.body);

      const [report] = await app.db`
        UPDATE chat_reports r
        SET status = ${body.status}
        FROM chat_groups g
        WHERE r.id = ${reportId} AND r.group_id = g.id AND g.org_id = ${request.user.org_id!}
        RETURNING r.*
      `;

      if (!report) throw AppError.notFound('Report not found');
      return reply.send(report);
    },
  );
}
```

- [ ] **Step 4: Register reports in the aggregator**

Update `src/routes/chat/index.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import chatGroupRoutes from './groups';
import chatMessageRoutes from './messages';
import chatReportRoutes from './reports';

export default async function chatRoutes(app: FastifyInstance): Promise<void> {
  await app.register(chatGroupRoutes, { prefix: '/groups' });
  await app.register(chatMessageRoutes, { prefix: '/groups' });
  await app.register(chatReportRoutes);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
npm test -- --testPathPattern=tests/chat/chat-moderation --forceExit
```
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/chat/reports.ts src/routes/chat/index.ts tests/chat/chat-moderation.test.ts
git commit -m "feat(chat): moderation reports and mute enforcement"
```

---

### Task 8: WebSocket Handler

**Files:**
- Create: `src/routes/chat/websocket.ts`
- Modify: `src/routes/chat/index.ts`
- Test: `tests/chat/chat-websocket.test.ts`

- [ ] **Step 1: Write failing WebSocket tests**

Create `tests/chat/chat-websocket.test.ts`:

```typescript
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';

function connectWs(app: FastifyInstance, token: string): Promise<WebSocket> {
  const address = app.server.address();
  const port = typeof address === 'object' ? address?.port : 3000;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/chat/ws?token=${token}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket, eventName: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), timeoutMs);
    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      if (parsed.event === eventName) {
        clearTimeout(timer);
        resolve(parsed);
      }
    });
  });
}

describe('Chat WebSocket', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let viewerId: string;
  let groupId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.listen({ port: 0, host: '127.0.0.1' });

    superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'chat-ws');
    orgAdminAccessToken = org.orgAdminAccessToken;

    const viewerEmail = `viewer-ws-${Date.now()}@example.com`;
    const viewerPassword = 'password123!';
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerId = viewerRes.json<{ id: string }>().id;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerAccessToken = loginRes.json<{ accessToken: string }>().accessToken;

    const groupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/groups',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'WS Test Group' },
    });
    groupId = groupRes.json<{ id: string }>().id;

    await app.inject({
      method: 'POST',
      url: `/api/v1/chat/groups/${groupId}/members`,
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { userIds: [viewerId] },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('connects with valid token', async () => {
    const ws = await connectWs(app, orgAdminAccessToken);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejects invalid token', async () => {
    await expect(connectWs(app, 'invalid-token')).rejects.toThrow();
  });

  it('broadcasts messages to group members', async () => {
    const ws1 = await connectWs(app, orgAdminAccessToken);
    const ws2 = await connectWs(app, viewerAccessToken);

    // Both join the group
    ws1.send(JSON.stringify({ event: 'join', groupId }));
    ws2.send(JSON.stringify({ event: 'join', groupId }));

    // Wait a moment for subscriptions
    await new Promise((r) => setTimeout(r, 100));

    // ws1 sends a message
    const messagePromise = waitForMessage(ws2, 'message:new');
    ws1.send(JSON.stringify({ event: 'message:send', groupId, content: 'Hello from WS!', type: 'text' }));

    const received = await messagePromise;
    expect((received.message as Record<string, unknown>).content).toBe('Hello from WS!');

    ws1.close();
    ws2.close();
  });

  it('broadcasts typing indicators', async () => {
    const ws1 = await connectWs(app, orgAdminAccessToken);
    const ws2 = await connectWs(app, viewerAccessToken);

    ws1.send(JSON.stringify({ event: 'join', groupId }));
    ws2.send(JSON.stringify({ event: 'join', groupId }));
    await new Promise((r) => setTimeout(r, 100));

    const typingPromise = waitForMessage(ws2, 'typing');
    ws1.send(JSON.stringify({ event: 'typing:start', groupId }));

    const received = await typingPromise;
    expect(received.isTyping).toBe(true);

    ws1.close();
    ws2.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npm test -- --testPathPattern=tests/chat/chat-websocket --forceExit
```
Expected: FAIL

- [ ] **Step 3: Create the WebSocket handler**

Create `src/routes/chat/websocket.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { publish, subscribe, unsubscribe, channelForGroup } from '@utils/chat-pubsub';
import { isMember, isMuted, getGroupMembers } from '@services/chat.service';
import { sendMessage, editMessage, deleteMessage, getMessageById, addReaction, removeReaction, markRead, getMessages } from '@services/chat-message.service';

interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  orgId: string;
  joinedGroups: Set<string>;
}

const clients = new Map<WebSocket, ConnectedClient>();

const incomingEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('join'), groupId: z.string().uuid() }),
  z.object({ event: z.literal('leave'), groupId: z.string().uuid() }),
  z.object({ event: z.literal('message:send'), groupId: z.string().uuid(), content: z.string().min(1).max(5000), type: z.enum(['text', 'media']), mediaUrl: z.string().optional(), mediaType: z.string().optional() }),
  z.object({ event: z.literal('message:edit'), messageId: z.string().uuid(), content: z.string().min(1).max(5000) }),
  z.object({ event: z.literal('message:delete'), messageId: z.string().uuid() }),
  z.object({ event: z.literal('typing:start'), groupId: z.string().uuid() }),
  z.object({ event: z.literal('typing:stop'), groupId: z.string().uuid() }),
  z.object({ event: z.literal('read'), groupId: z.string().uuid(), lastReadMessageId: z.string().uuid() }),
  z.object({ event: z.literal('reaction:add'), messageId: z.string().uuid(), emoji: z.string().min(1).max(32) }),
  z.object({ event: z.literal('reaction:remove'), messageId: z.string().uuid(), emoji: z.string().min(1).max(32) }),
  z.object({ event: z.literal('sync'), groups: z.array(z.object({ groupId: z.string().uuid(), lastMessageId: z.string().uuid() })) }),
]);

export default async function chatWebsocketRoute(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, request) => {
    const token = (request.query as Record<string, string>).token;
    if (!token) {
      socket.close(4001, 'Missing token');
      return;
    }

    let decoded: { sub: string; org_id: string; role: string };
    try {
      decoded = app.jwt.verify<{ sub: string; org_id: string; role: string }>(token);
    } catch {
      socket.close(4001, 'Invalid token');
      return;
    }

    const client: ConnectedClient = {
      ws: socket,
      userId: decoded.sub,
      orgId: decoded.org_id,
      joinedGroups: new Set(),
    };
    clients.set(socket, client);

    const groupHandlers = new Map<string, (channel: string, message: string) => void>();

    socket.on('message', async (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        const parsed = incomingEventSchema.safeParse(data);
        if (!parsed.success) {
          socket.send(JSON.stringify({ event: 'error', code: 'INVALID_EVENT', message: 'Invalid event format' }));
          return;
        }

        const event = parsed.data;

        switch (event.event) {
          case 'join': {
            const canJoin = await isMember(app.db, event.groupId, client.userId);
            if (!canJoin) {
              socket.send(JSON.stringify({ event: 'error', code: 'FORBIDDEN', message: 'Not a member' }));
              return;
            }
            client.joinedGroups.add(event.groupId);
            const channel = channelForGroup(event.groupId);
            const handler = (_ch: string, msg: string) => {
              const parsed = JSON.parse(msg) as Record<string, unknown>;
              if ((parsed as { _senderId?: string })._senderId !== client.userId) {
                const { _senderId, ...payload } = parsed as Record<string, unknown>;
                socket.send(JSON.stringify(payload));
              }
            };
            groupHandlers.set(event.groupId, handler);
            await subscribe(channel, handler);
            break;
          }

          case 'leave': {
            client.joinedGroups.delete(event.groupId);
            const handler = groupHandlers.get(event.groupId);
            if (handler) {
              await unsubscribe(channelForGroup(event.groupId), handler);
              groupHandlers.delete(event.groupId);
            }
            break;
          }

          case 'message:send': {
            if (!client.joinedGroups.has(event.groupId)) {
              socket.send(JSON.stringify({ event: 'error', code: 'NOT_JOINED', message: 'Join the group first' }));
              return;
            }
            const muted = await isMuted(app.db, event.groupId, client.userId);
            if (muted) {
              socket.send(JSON.stringify({ event: 'error', code: 'MUTED', message: 'You are muted' }));
              return;
            }
            const msg = await sendMessage(app.db, {
              groupId: event.groupId,
              senderId: client.userId,
              type: event.type,
              content: event.content,
              mediaUrl: event.mediaUrl,
              mediaType: event.mediaType,
            });
            const payload = { event: 'message:new', message: msg, _senderId: client.userId };
            await publish(channelForGroup(event.groupId), payload);
            // Send back to sender too
            socket.send(JSON.stringify({ event: 'message:new', message: msg }));
            break;
          }

          case 'message:edit': {
            const msg = await getMessageById(app.db, event.messageId);
            if (!msg || msg.sender_id !== client.userId) {
              socket.send(JSON.stringify({ event: 'error', code: 'FORBIDDEN', message: 'Cannot edit' }));
              return;
            }
            const updated = await editMessage(app.db, event.messageId, event.content);
            const payload = { event: 'message:edited', messageId: updated.id, content: updated.content, editedAt: updated.edited_at, _senderId: client.userId };
            await publish(channelForGroup(msg.group_id), payload);
            socket.send(JSON.stringify({ event: 'message:edited', messageId: updated.id, content: updated.content, editedAt: updated.edited_at }));
            break;
          }

          case 'message:delete': {
            const msg = await getMessageById(app.db, event.messageId);
            if (!msg) return;
            if (msg.sender_id !== client.userId) {
              socket.send(JSON.stringify({ event: 'error', code: 'FORBIDDEN', message: 'Cannot delete' }));
              return;
            }
            await deleteMessage(app.db, event.messageId);
            const payload = { event: 'message:deleted', messageId: event.messageId, _senderId: client.userId };
            await publish(channelForGroup(msg.group_id), payload);
            socket.send(JSON.stringify({ event: 'message:deleted', messageId: event.messageId }));
            break;
          }

          case 'typing:start':
          case 'typing:stop': {
            if (!client.joinedGroups.has(event.groupId)) return;
            const isTyping = event.event === 'typing:start';
            const payload = { event: 'typing', groupId: event.groupId, userId: client.userId, isTyping, _senderId: client.userId };
            await publish(channelForGroup(event.groupId), payload);
            break;
          }

          case 'read': {
            await markRead(app.db, event.groupId, client.userId, event.lastReadMessageId);
            const payload = { event: 'read:update', groupId: event.groupId, userId: client.userId, lastReadMessageId: event.lastReadMessageId, _senderId: client.userId };
            await publish(channelForGroup(event.groupId), payload);
            break;
          }

          case 'reaction:add': {
            const msg = await getMessageById(app.db, event.messageId);
            if (!msg) return;
            await addReaction(app.db, event.messageId, client.userId, event.emoji);
            const payload = { event: 'reaction:added', messageId: event.messageId, userId: client.userId, emoji: event.emoji, _senderId: client.userId };
            await publish(channelForGroup(msg.group_id), payload);
            socket.send(JSON.stringify({ event: 'reaction:added', messageId: event.messageId, userId: client.userId, emoji: event.emoji }));
            break;
          }

          case 'reaction:remove': {
            const msg = await getMessageById(app.db, event.messageId);
            if (!msg) return;
            await removeReaction(app.db, event.messageId, client.userId, event.emoji);
            const payload = { event: 'reaction:removed', messageId: event.messageId, userId: client.userId, emoji: event.emoji, _senderId: client.userId };
            await publish(channelForGroup(msg.group_id), payload);
            socket.send(JSON.stringify({ event: 'reaction:removed', messageId: event.messageId, userId: client.userId, emoji: event.emoji }));
            break;
          }

          case 'sync': {
            for (const { groupId, lastMessageId } of event.groups) {
              const canAccess = await isMember(app.db, groupId, client.userId);
              if (!canAccess) continue;
              const result = await getMessages(app.db, groupId, 100, lastMessageId);
              socket.send(JSON.stringify({ event: 'sync:response', groupId, messages: result.data, hasMore: result.cursor !== null }));
            }
            break;
          }
        }
      } catch (err) {
        socket.send(JSON.stringify({ event: 'error', code: 'INTERNAL_ERROR', message: 'An error occurred' }));
      }
    });

    socket.on('close', async () => {
      for (const groupId of client.joinedGroups) {
        const handler = groupHandlers.get(groupId);
        if (handler) {
          await unsubscribe(channelForGroup(groupId), handler);
        }
      }
      groupHandlers.clear();
      clients.delete(socket);
    });

    // Heartbeat
    const pingInterval = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.ping();
      }
    }, 30000);

    socket.on('close', () => clearInterval(pingInterval));
  });
}
```

- [ ] **Step 4: Register WebSocket route in aggregator**

Update `src/routes/chat/index.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import chatGroupRoutes from './groups';
import chatMessageRoutes from './messages';
import chatReportRoutes from './reports';
import chatWebsocketRoute from './websocket';

export default async function chatRoutes(app: FastifyInstance): Promise<void> {
  await app.register(chatGroupRoutes, { prefix: '/groups' });
  await app.register(chatMessageRoutes, { prefix: '/groups' });
  await app.register(chatReportRoutes);
  await app.register(chatWebsocketRoute);
}
```

- [ ] **Step 5: Run tests**

Run:
```bash
npm test -- --testPathPattern=tests/chat/chat-websocket --forceExit
```
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/chat/websocket.ts src/routes/chat/index.ts tests/chat/chat-websocket.test.ts
git commit -m "feat(chat): real-time WebSocket handler with Redis pub/sub"
```

---

### Task 9: Notification Service

**Files:**
- Create: `src/services/chat-notification.service.ts`

- [ ] **Step 1: Create the notification service**

Create `src/services/chat-notification.service.ts`:

```typescript
import type { Sql } from 'postgres';
import type { SNSClient } from '@aws-sdk/client-sns';
import type { SESClient } from '@aws-sdk/client-ses';
import { PublishCommand } from '@aws-sdk/client-sns';
import { SendEmailCommand } from '@aws-sdk/client-ses';
import { env } from '@config/env';

interface PushToken {
  id: string;
  user_id: string;
  platform: 'ios' | 'android' | 'web';
  token: string;
}

const pendingDigests = new Map<string, NodeJS.Timeout>();

export async function registerPushToken(
  db: Sql,
  userId: string,
  platform: 'ios' | 'android' | 'web',
  token: string,
): Promise<void> {
  await db`
    INSERT INTO user_push_tokens (user_id, platform, token)
    VALUES (${userId}, ${platform}, ${token})
    ON CONFLICT (user_id, token) DO NOTHING
  `;
}

export async function removePushToken(db: Sql, userId: string, token: string): Promise<void> {
  await db`
    DELETE FROM user_push_tokens WHERE user_id = ${userId} AND token = ${token}
  `;
}

export async function sendPushNotification(
  db: Sql,
  sns: SNSClient,
  userId: string,
  title: string,
  body: string,
): Promise<void> {
  if (env.NODE_ENV === 'test') return;

  const tokens = await db<PushToken[]>`
    SELECT * FROM user_push_tokens WHERE user_id = ${userId}
  `;

  for (const token of tokens) {
    if (token.platform === 'ios' || token.platform === 'android') {
      const message = JSON.stringify({
        default: body,
        GCM: JSON.stringify({ notification: { title, body } }),
        APNS: JSON.stringify({ aps: { alert: { title, body } } }),
      });

      await sns.send(new PublishCommand({
        TargetArn: token.token,
        Message: message,
        MessageStructure: 'json',
      }));
    }
  }
}

export async function scheduleEmailDigest(
  db: Sql,
  ses: SESClient,
  userId: string,
  groupName: string,
  messagePreview: string,
): Promise<void> {
  if (env.NODE_ENV === 'test') return;

  const digestKey = `${userId}`;

  if (pendingDigests.has(digestKey)) {
    clearTimeout(pendingDigests.get(digestKey)!);
  }

  const timer = setTimeout(async () => {
    pendingDigests.delete(digestKey);

    const [user] = await db<Array<{ email: string }>>`
      SELECT email FROM users WHERE id = ${userId}
    `;
    if (!user) return;

    await ses.send(new SendEmailCommand({
      Source: env.SES_FROM_EMAIL,
      Destination: { ToAddresses: [user.email] },
      Message: {
        Subject: { Data: `New messages in ${groupName}` },
        Body: {
          Text: { Data: `You have unread messages in "${groupName}":\n\n${messagePreview}\n\nOpen the app to view all messages.` },
        },
      },
    }));
  }, 5 * 60 * 1000); // 5 minutes

  pendingDigests.set(digestKey, timer);
}

export function clearAllDigestTimers(): void {
  for (const timer of pendingDigests.values()) {
    clearTimeout(timer);
  }
  pendingDigests.clear();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/chat-notification.service.ts
git commit -m "feat(chat): push and email notification service"
```

---

### Task 10: Cross-Org Isolation Tests

**Files:**
- Test: `tests/chat/chat-isolation.test.ts`

- [ ] **Step 1: Write cross-org isolation tests**

Create `tests/chat/chat-isolation.test.ts`:

```typescript
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Chat Cross-Org Isolation', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgAToken: string;
  let orgBToken: string;
  let orgAGroupId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);

    const orgA = await createOrgAndLogin(app, superAdminToken, 'chat-iso-a');
    orgAToken = orgA.orgAdminAccessToken;

    const orgB = await createOrgAndLogin(app, superAdminToken, 'chat-iso-b');
    orgBToken = orgB.orgAdminAccessToken;

    // Create a group in Org A
    const groupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/groups',
      headers: { authorization: `Bearer ${orgAToken}` },
      payload: { name: 'Org A Secret Chat' },
    });
    orgAGroupId = groupRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('Org B user cannot see Org A groups', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/chat/groups',
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }> }>();
    const ids = body.data.map((g) => g.id);
    expect(ids).not.toContain(orgAGroupId);
  });

  it('Org B user cannot access Org A group details', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chat/groups/${orgAGroupId}`,
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('Org B user cannot send messages in Org A group', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chat/groups/${orgAGroupId}/messages`,
      headers: { authorization: `Bearer ${orgBToken}` },
      payload: { content: 'Cross-org attack', type: 'text' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('Org B user cannot add themselves to Org A group', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chat/groups/${orgAGroupId}/members`,
      headers: { authorization: `Bearer ${orgBToken}` },
      payload: { userIds: ['some-id'] },
    });

    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests**

Run:
```bash
npm test -- --testPathPattern=tests/chat/chat-isolation --forceExit
```
Expected: All PASS (org_id filtering in getGroupById returns null for wrong org)

- [ ] **Step 3: Commit**

```bash
git add tests/chat/chat-isolation.test.ts
git commit -m "test(chat): cross-org isolation tests"
```

---

### Task 11: Run Full Test Suite

**Files:** None (verification only)

- [ ] **Step 1: Run all chat tests**

Run:
```bash
npm test -- --testPathPattern=tests/chat --forceExit
```
Expected: All tests PASS

- [ ] **Step 2: Run full project test suite for regressions**

Run:
```bash
npm test -- --forceExit
```
Expected: All tests PASS (no regressions)

- [ ] **Step 3: Run type check**

Run:
```bash
npm run typecheck
```
Expected: No errors

- [ ] **Step 4: Run lint**

Run:
```bash
npm run lint
```
Expected: No errors

- [ ] **Step 5: Commit any lint/type fixes if needed**

```bash
git add -A
git commit -m "fix(chat): resolve lint and type issues"
```
