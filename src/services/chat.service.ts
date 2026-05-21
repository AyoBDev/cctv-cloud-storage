import type { Sql } from 'postgres';
import { AppError } from '@utils/errors';

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

export interface ChatGroupMemberWithUser {
  group_id: string;
  user_id: string;
  role: 'owner' | 'member';
  muted_until: Date | null;
  joined_at: Date;
  email: string;
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
  const rows = await db<ChatGroup[]>`
    INSERT INTO chat_groups (org_id, name, description, created_by)
    VALUES (${input.orgId}, ${input.name}, ${input.description ?? null}, ${input.createdBy})
    RETURNING *
  `;

  const group = rows[0];
  if (!group) throw new Error('Insert returned no rows');

  // Add creator as owner
  await db`
    INSERT INTO chat_group_members (group_id, user_id, role)
    VALUES (${group.id}, ${input.createdBy}, 'owner')
  `;

  return group;
}

export async function listGroupsForUser(
  db: Sql,
  userId: string,
  orgId: string,
): Promise<ChatGroup[]> {
  const rows = await db<ChatGroup[]>`
    SELECT g.*
    FROM chat_groups g
    INNER JOIN chat_group_members m ON m.group_id = g.id
    WHERE m.user_id = ${userId} AND g.org_id = ${orgId}
    ORDER BY g.updated_at DESC
  `;
  return rows;
}

export async function getGroupById(
  db: Sql,
  groupId: string,
  orgId: string,
): Promise<ChatGroup | null> {
  const rows = await db<ChatGroup[]>`
    SELECT * FROM chat_groups WHERE id = ${groupId} AND org_id = ${orgId}
  `;
  return rows[0] ?? null;
}

export async function updateGroup(
  db: Sql,
  groupId: string,
  input: UpdateGroupInput,
): Promise<ChatGroup> {
  const rows = await db<ChatGroup[]>`
    UPDATE chat_groups
    SET name = COALESCE(${input.name ?? null}, name),
        description = COALESCE(${input.description ?? null}, description),
        updated_at = now()
    WHERE id = ${groupId}
    RETURNING *
  `;

  const group = rows[0];
  if (!group) throw AppError.notFound('Group not found');
  return group;
}

export async function deleteGroup(db: Sql, groupId: string): Promise<void> {
  await db`DELETE FROM chat_groups WHERE id = ${groupId}`;
}

export async function isMember(db: Sql, groupId: string, userId: string): Promise<boolean> {
  const rows = await db<[{ exists: boolean }]>`
    SELECT EXISTS(
      SELECT 1 FROM chat_group_members WHERE group_id = ${groupId} AND user_id = ${userId}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

export async function getMemberRole(
  db: Sql,
  groupId: string,
  userId: string,
): Promise<'owner' | 'member' | null> {
  const rows = await db<[{ role: 'owner' | 'member' }?]>`
    SELECT role FROM chat_group_members WHERE group_id = ${groupId} AND user_id = ${userId}
  `;
  return rows[0]?.role ?? null;
}

export async function addMembers(
  db: Sql,
  groupId: string,
  userIds: string[],
  orgId: string,
): Promise<number> {
  // Validate users belong to same org
  const validUsers = await db<Array<{ id: string }>>`
    SELECT id FROM users WHERE id = ANY(${userIds}) AND org_id = ${orgId}
  `;

  if (validUsers.length === 0) return 0;

  const validIds = validUsers.map((u) => u.id);

  // Insert with ON CONFLICT DO NOTHING
  const inserted = await db`
    INSERT INTO chat_group_members (group_id, user_id, role)
    SELECT ${groupId}, unnest(${validIds}::uuid[]), 'member'
    ON CONFLICT (group_id, user_id) DO NOTHING
  `;

  return inserted.count;
}

export async function removeMember(db: Sql, groupId: string, userId: string): Promise<void> {
  await db`DELETE FROM chat_group_members WHERE group_id = ${groupId} AND user_id = ${userId}`;
}

export async function muteMember(
  db: Sql,
  groupId: string,
  userId: string,
  mutedUntil: Date,
): Promise<void> {
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
  const rows = await db<[{ is_muted: boolean }]>`
    SELECT (muted_until IS NOT NULL AND muted_until > now()) AS is_muted
    FROM chat_group_members
    WHERE group_id = ${groupId} AND user_id = ${userId}
  `;
  return rows[0]?.is_muted ?? false;
}

export async function getGroupMembers(
  db: Sql,
  groupId: string,
): Promise<ChatGroupMemberWithUser[]> {
  const rows = await db<ChatGroupMemberWithUser[]>`
    SELECT m.group_id, m.user_id, m.role, m.muted_until, m.joined_at, u.email
    FROM chat_group_members m
    INNER JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ${groupId}
    ORDER BY m.joined_at ASC
  `;
  return rows;
}
