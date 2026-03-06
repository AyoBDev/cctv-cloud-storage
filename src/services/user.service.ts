import type { Sql } from 'postgres';
import { AppError } from '@utils/errors';

export interface User {
  id: string;
  email: string;
  role: 'super_admin' | 'org_admin' | 'viewer';
  org_id: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number };
}

export async function listUsers(
  db: Sql,
  page: number,
  limit: number,
  orgId?: string,
): Promise<PaginatedResult<User>> {
  const offset = (page - 1) * limit;

  const countRows = orgId
    ? await db<[{ count: string }]>`SELECT COUNT(*) FROM users WHERE org_id = ${orgId}`
    : await db<[{ count: string }]>`SELECT COUNT(*) FROM users`;

  const countRow = countRows[0];
  const total = countRow ? parseInt(countRow.count, 10) : 0;

  const data = orgId
    ? await db<User[]>`
        SELECT id, email, role, org_id, is_active, created_at, updated_at
        FROM users
        WHERE org_id = ${orgId}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `
    : await db<User[]>`
        SELECT id, email, role, org_id, is_active, created_at, updated_at
        FROM users
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

  return { data, pagination: { page, limit, total } };
}

export async function getUserById(db: Sql, userId: string): Promise<User> {
  const rows = await db<User[]>`
    SELECT id, email, role, org_id, is_active, created_at, updated_at
    FROM users
    WHERE id = ${userId}
  `;

  const user = rows[0];
  if (!user) throw AppError.notFound('User not found');
  return user;
}

export async function updateUserStatus(
  db: Sql,
  userId: string,
  isActive: boolean,
): Promise<User> {
  const rows = await db<User[]>`
    UPDATE users
    SET is_active = ${isActive}
    WHERE id = ${userId}
    RETURNING id, email, role, org_id, is_active, created_at, updated_at
  `;

  const user = rows[0];
  if (!user) throw AppError.notFound('User not found');
  return user;
}

export async function deleteUser(db: Sql, userId: string): Promise<void> {
  const rows = await db<[{ role: string }]>`
    SELECT role FROM users WHERE id = ${userId}
  `;

  const user = rows[0];
  if (!user) throw AppError.notFound('User not found');

  if (user.role === 'super_admin') {
    throw AppError.forbidden('Cannot delete a super admin');
  }

  await db`DELETE FROM users WHERE id = ${userId}`;
}
