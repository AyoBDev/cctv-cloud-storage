import type { Sql } from 'postgres';
import { hashPassword } from '@utils/password';
import { AppError } from '@utils/errors';

export interface OrgUser {
  id: string;
  email: string;
  role: 'org_admin' | 'viewer';
  org_id: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number };
}

export async function listOrgUsers(
  db: Sql,
  orgId: string,
  page: number,
  limit: number,
): Promise<PaginatedResult<OrgUser>> {
  const offset = (page - 1) * limit;

  const countRows = await db<[{ count: string }]>`
    SELECT COUNT(*) FROM users WHERE org_id = ${orgId}
  `;
  const total = countRows[0] ? parseInt(countRows[0].count, 10) : 0;

  const data = await db<OrgUser[]>`
    SELECT id, email, role, org_id, is_active, created_at, updated_at
    FROM users
    WHERE org_id = ${orgId}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return { data, pagination: { page, limit, total } };
}

export async function createOrgUser(
  db: Sql,
  orgId: string,
  email: string,
  password: string,
): Promise<OrgUser> {
  const passwordHash = await hashPassword(password);

  try {
    const rows = await db<OrgUser[]>`
      INSERT INTO users (email, password_hash, role, org_id)
      VALUES (${email}, ${passwordHash}, 'viewer', ${orgId})
      RETURNING id, email, role, org_id, is_active, created_at, updated_at
    `;

    const user = rows[0];
    if (!user) throw new Error('Insert returned no rows');
    return user;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      throw AppError.conflict('Email already exists');
    }
    throw err;
  }
}

export async function getOrgUserById(db: Sql, orgId: string, userId: string): Promise<OrgUser> {
  const rows = await db<OrgUser[]>`
    SELECT id, email, role, org_id, is_active, created_at, updated_at
    FROM users
    WHERE id = ${userId}
  `;

  const user = rows[0];
  if (!user) throw AppError.notFound('User not found');

  if (user.org_id !== orgId) {
    throw AppError.forbidden('Access denied');
  }

  return user;
}

export async function updateOrgUser(
  db: Sql,
  orgId: string,
  userId: string,
  updates: { is_active?: boolean },
): Promise<OrgUser> {
  // Verify user belongs to org
  const existing = await getOrgUserById(db, orgId, userId);

  if (updates.is_active !== undefined) {
    const rows = await db<OrgUser[]>`
      UPDATE users
      SET is_active = ${updates.is_active}
      WHERE id = ${existing.id} AND org_id = ${orgId}
      RETURNING id, email, role, org_id, is_active, created_at, updated_at
    `;

    const user = rows[0];
    if (!user) throw AppError.notFound('User not found');
    return user;
  }

  return existing;
}

export async function deleteOrgUser(db: Sql, orgId: string, userId: string): Promise<void> {
  const user = await getOrgUserById(db, orgId, userId);

  if (user.role === 'org_admin') {
    throw AppError.forbidden('Cannot delete an org admin');
  }

  await db`DELETE FROM users WHERE id = ${user.id} AND org_id = ${orgId}`;
}
