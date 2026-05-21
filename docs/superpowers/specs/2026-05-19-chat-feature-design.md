# Chat Feature Design Spec

## Overview

Real-time group chat for users within the same organisation. Groups are arbitrary (not camera-tied). Any user (org_admin or viewer) can create and manage groups. Messages support text, media attachments, emoji reactions, editing, and deletion. Offline users receive push and email notifications.

## Architecture

- **Transport:** WebSocket via `@fastify/websocket` for real-time, REST endpoints for history/fallback
- **Broadcasting:** Redis pub/sub — one channel per group (`chat:group:{groupId}`)
- **Persistence:** PostgreSQL for messages, groups, memberships, receipts, reactions, reports
- **Media:** S3 with pre-signed URLs for upload/download
- **Push notifications:** AWS SNS (mobile) + Web Push API (browser)
- **Email notifications:** AWS SES (batched — 5-min digest for offline users)
- **Horizontal scaling:** All ECS instances subscribe to Redis pub/sub; no sticky sessions needed

## Data Model

### Enums

- `chat_member_role`: `owner`, `member`
- `chat_message_type`: `text`, `media`, `system`
- `chat_report_status`: `pending`, `reviewed`, `dismissed`
- `push_token_platform`: `ios`, `android`, `web`

### Tables

#### `chat_groups`

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| org_id | uuid | FK → organizations(id), NOT NULL |
| name | varchar(100) | NOT NULL |
| description | text | nullable |
| created_by | uuid | FK → users(id) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

Indexes: `idx_chat_groups_org_id`

#### `chat_group_members`

| Column | Type | Constraints |
|--------|------|-------------|
| group_id | uuid | FK → chat_groups(id) ON DELETE CASCADE |
| user_id | uuid | FK → users(id) ON DELETE CASCADE |
| role | chat_member_role | NOT NULL, default 'member' |
| muted_until | timestamptz | nullable |
| joined_at | timestamptz | default now() |

PK: `(group_id, user_id)`
Indexes: `idx_chat_group_members_user`

#### `chat_messages`

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| group_id | uuid | FK → chat_groups(id) ON DELETE CASCADE |
| sender_id | uuid | FK → users(id), nullable (null for system msgs) |
| type | chat_message_type | NOT NULL |
| content | text | NOT NULL |
| media_url | text | nullable |
| media_type | varchar(50) | nullable |
| edited_at | timestamptz | nullable |
| deleted_at | timestamptz | nullable (soft delete) |
| created_at | timestamptz | default now() |

Indexes: `idx_chat_messages_group_created` (group_id, created_at DESC)

#### `chat_message_reactions`

| Column | Type | Constraints |
|--------|------|-------------|
| message_id | uuid | FK → chat_messages(id) ON DELETE CASCADE |
| user_id | uuid | FK → users(id) ON DELETE CASCADE |
| emoji | varchar(32) | NOT NULL |
| created_at | timestamptz | default now() |

PK: `(message_id, user_id, emoji)`

#### `chat_read_receipts`

| Column | Type | Constraints |
|--------|------|-------------|
| group_id | uuid | FK → chat_groups(id) ON DELETE CASCADE |
| user_id | uuid | FK → users(id) ON DELETE CASCADE |
| last_read_message_id | uuid | FK → chat_messages(id) |
| read_at | timestamptz | default now() |

PK: `(group_id, user_id)`

#### `chat_reports`

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| group_id | uuid | FK → chat_groups(id) |
| reported_by | uuid | FK → users(id) |
| reported_user | uuid | FK → users(id) |
| message_id | uuid | FK → chat_messages(id), nullable |
| reason | text | NOT NULL |
| status | chat_report_status | NOT NULL, default 'pending' |
| created_at | timestamptz | default now() |

Indexes: `idx_chat_reports_org_status` (via join on chat_groups.org_id)

#### `user_push_tokens`

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → users(id) ON DELETE CASCADE |
| platform | push_token_platform | NOT NULL |
| token | text | NOT NULL |
| created_at | timestamptz | default now() |

Unique: `(user_id, token)`

## API Routes

Prefix: `/api/v1/chat`

### Group Management

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/groups` | Create group | requireUser |
| GET | `/groups` | List user's groups | requireUser |
| GET | `/groups/:groupId` | Group details + members | requireUser, must be member |
| PATCH | `/groups/:groupId` | Update name/description | requireUser, owner or org_admin |
| DELETE | `/groups/:groupId` | Delete group | requireUser, owner or org_admin |

### Member Management

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/groups/:groupId/members` | Add members | requireUser, member |
| DELETE | `/groups/:groupId/members/:userId` | Remove member | requireUser, owner/org_admin/self |
| PATCH | `/groups/:groupId/members/:userId/mute` | Mute member | requireUser, owner or org_admin |
| PATCH | `/groups/:groupId/members/:userId/unmute` | Unmute member | requireUser, owner or org_admin |

### Messages

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/groups/:groupId/messages` | Paginated history (cursor-based) | requireUser, member |
| POST | `/groups/:groupId/messages` | Send message (REST fallback) | requireUser, member, not muted |
| PATCH | `/groups/:groupId/messages/:messageId` | Edit message | requireUser, sender only |
| DELETE | `/groups/:groupId/messages/:messageId` | Soft-delete | requireUser, sender/owner/org_admin |

### Media

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/groups/:groupId/media/upload` | Get pre-signed S3 upload URL | requireUser, member, not muted |

### Reactions

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/groups/:groupId/messages/:messageId/reactions` | Add reaction | requireUser, member |
| DELETE | `/groups/:groupId/messages/:messageId/reactions/:emoji` | Remove reaction | requireUser, member |

### Read Receipts

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/groups/:groupId/read` | Mark read | requireUser, member |

### Reports

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/groups/:groupId/reports` | Report user/message | requireUser, member |
| GET | `/reports` | List org reports | requireOrgAdmin |
| PATCH | `/reports/:reportId` | Update report status | requireOrgAdmin |

## WebSocket Protocol

### Connection

- Endpoint: `WS /api/v1/chat/ws?token=<JWT>`
- Auth validated on upgrade; rejected if invalid/expired
- Heartbeat: server pings every 30s, client must pong within 10s

### Client → Server Events

```json
{ "event": "join", "groupId": "<uuid>" }
{ "event": "leave", "groupId": "<uuid>" }
{ "event": "message:send", "groupId": "<uuid>", "content": "...", "type": "text" }
{ "event": "message:send", "groupId": "<uuid>", "content": "caption", "type": "media", "mediaUrl": "s3-key", "mediaType": "image/png" }
{ "event": "message:edit", "messageId": "<uuid>", "content": "updated" }
{ "event": "message:delete", "messageId": "<uuid>" }
{ "event": "typing:start", "groupId": "<uuid>" }
{ "event": "typing:stop", "groupId": "<uuid>" }
{ "event": "read", "groupId": "<uuid>", "lastReadMessageId": "<uuid>" }
{ "event": "reaction:add", "messageId": "<uuid>", "emoji": "👍" }
{ "event": "reaction:remove", "messageId": "<uuid>", "emoji": "👍" }
{ "event": "sync", "groups": [{ "groupId": "<uuid>", "lastMessageId": "<uuid>" }] }
```

### Server → Client Events

```json
{ "event": "message:new", "message": { "id", "groupId", "senderId", "senderName", "type", "content", "mediaUrl", "mediaType", "createdAt" } }
{ "event": "message:edited", "messageId": "<uuid>", "content": "...", "editedAt": "..." }
{ "event": "message:deleted", "messageId": "<uuid>" }
{ "event": "typing", "groupId": "<uuid>", "userId": "<uuid>", "userName": "...", "isTyping": true/false }
{ "event": "read:update", "groupId": "<uuid>", "userId": "<uuid>", "lastReadMessageId": "<uuid>" }
{ "event": "reaction:added", "messageId": "<uuid>", "userId": "<uuid>", "emoji": "..." }
{ "event": "reaction:removed", "messageId": "<uuid>", "userId": "<uuid>", "emoji": "..." }
{ "event": "member:joined", "groupId": "<uuid>", "userId": "<uuid>", "userName": "..." }
{ "event": "member:left", "groupId": "<uuid>", "userId": "<uuid>" }
{ "event": "member:muted", "groupId": "<uuid>", "userId": "<uuid>", "mutedUntil": "..." }
{ "event": "error", "code": "...", "message": "..." }
```

### Reconnection

On reconnect, client sends `sync` with last known message ID per group. Server responds with:

```json
{ "event": "sync:response", "groupId": "<uuid>", "messages": [ /* array of message objects */ ], "hasMore": true/false }
```

Max 100 messages per group per sync. If `hasMore` is true, client uses REST pagination for older history.

## Broadcasting Architecture

1. Message received via WebSocket (or REST)
2. Server validates: membership, not muted, org_id match
3. Message persisted to PostgreSQL
4. Published to Redis channel `chat:group:{groupId}`
5. All ECS instances subscribed to that channel deliver to their local WebSocket connections
6. Offline members queued for push + email notification

## Media Uploads

### Flow

1. Client: `POST /groups/:groupId/media/upload` with `{ fileName, contentType }`
2. Server: returns pre-signed S3 PUT URL (5-min TTL)
3. Client: uploads directly to S3
4. Client: sends message with S3 key via WebSocket/REST

### S3 Path

```
orgs/{orgId}/chat/{groupId}/{year}-{month}/{messageId}/{filename}
```

### Constraints

- Max file size: 25MB (enforced via pre-signed URL conditions)
- Allowed types: jpeg, png, gif, webp, mp4, webm, pdf, docx, xlsx
- Access: pre-signed GET URLs with 1-hour TTL in message history responses

## Offline Notifications

### Push Notifications

- Store device tokens in `user_push_tokens`
- AWS SNS for iOS/Android, Web Push API for browsers
- Sent immediately per message to offline members

### Email Notifications

- Batched: 5-minute digest window
- If user has unread messages after 5 minutes offline, send one summary email via SES
- Timer resets if more messages arrive before send
- Email contains: group name, message count, last few message previews, link to open chat

## Moderation

| Action | Owner | Org Admin | Member |
|--------|-------|-----------|--------|
| Remove member | Yes | Yes | No (self-leave only) |
| Mute member | Yes | Yes | No |
| Delete any message | Yes | Yes | No (own only) |
| Report user/message | Yes | Yes | Yes |
| Review reports | No | Yes | No |

- Muted users cannot send messages or reactions
- Mute has a duration (`muted_until`); can be indefinite (far-future timestamp)
- System message generated on mute/unmute/join/leave/remove

## New Files

```
src/plugins/websocket.ts              — @fastify/websocket registration
src/utils/chat-pubsub.ts             — Redis pub/sub wrapper
src/services/chat.service.ts          — group CRUD, membership
src/services/chat-message.service.ts  — message persistence, edit, delete
src/services/chat-notification.service.ts — push + email batching
src/routes/chat/index.ts              — REST routes
src/routes/chat/websocket.ts          — WebSocket handler
src/db/migrations/009_chat_schema.ts  — all tables + enums
```

## Dependencies to Add

```
@fastify/websocket    — WebSocket support
web-push              — Web Push notifications (browser)
```

AWS SNS accessed via existing AWS SDK (`SNSClient` added to AWS plugin).

## Multi-Tenancy

All queries scoped to `org_id`:
- Group creation sets `org_id` from `req.user.org_id`
- Group listing filters by `org_id`
- Member additions validate target user belongs to same org
- Reports visible only to org admins of the same org

## Testing Strategy

- Unit tests: service layer (group CRUD, message logic, moderation rules)
- Integration tests: REST endpoints with org isolation (Org A cannot access Org B groups)
- WebSocket tests: connection, auth rejection, message broadcast, reconnect sync
- Cross-org isolation: user from Org A cannot join/message in Org B group
