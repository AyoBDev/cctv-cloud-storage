import type { Sql, TransactionSql } from 'postgres';
import { hashPassword } from '@utils/password';
import { AppError } from '@utils/errors';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number };
}

interface PostgresError {
  code?: string;
  constraint?: string;
}

function isPostgresError(err: unknown): err is PostgresError {
  return typeof err === 'object' && err !== null && 'code' in err;
}

export async function listOrganizations(
  db: Sql,
  page: number,
  limit: number,
): Promise<PaginatedResult<Organization>> {
  const offset = (page - 1) * limit;

  const countRows = await db<[{ count: string }]>`SELECT COUNT(*) FROM organizations`;
  const countRow = countRows[0];
  const total = countRow ? parseInt(countRow.count, 10) : 0;

  const data = await db<Organization[]>`
    SELECT id, name, slug, is_active, created_at, updated_at
    FROM organizations
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return { data, pagination: { page, limit, total } };
}

export async function createOrganizationWithAdmin(
  db: Sql,
  params: { name: string; slug: string; adminEmail: string; adminPassword: string },
): Promise<Organization> {
  try {
    const result = await db.begin(async (tx: TransactionSql) => {
      const orgRows = await (tx as unknown as Sql)<Organization[]>`
        INSERT INTO organizations (name, slug)
        VALUES (${params.name}, ${params.slug})
        RETURNING id, name, slug, is_active, created_at, updated_at
      `;

      const org = orgRows[0];
      if (!org) throw new Error('Failed to create organization');

      const passwordHash = await hashPassword(params.adminPassword);

      await (tx as unknown as Sql)`
        INSERT INTO users (email, password_hash, role, org_id)
        VALUES (${params.adminEmail}, ${passwordHash}, 'org_admin', ${org.id})
      `;

      return org;
    });

    return result as Organization;
  } catch (err) {
    if (isPostgresError(err) && err.code === '23505') {
      if (err.constraint?.includes('email')) {
        throw AppError.conflict('Email already registered');
      }
      throw AppError.conflict('Slug already taken');
    }
    throw err;
  }
}

export async function getOrganizationById(db: Sql, orgId: string): Promise<Organization> {
  const rows = await db<Organization[]>`
    SELECT id, name, slug, is_active, created_at, updated_at
    FROM organizations
    WHERE id = ${orgId}
  `;

  const org = rows[0];
  if (!org) throw AppError.notFound('Organization not found');
  return org;
}

export async function updateOrganization(
  db: Sql,
  orgId: string,
  updates: { name?: string; slug?: string; is_active?: boolean },
): Promise<Organization> {
  try {
    const rows = await db<Organization[]>`
      UPDATE organizations
      SET ${db(updates)}
      WHERE id = ${orgId}
      RETURNING id, name, slug, is_active, created_at, updated_at
    `;

    const org = rows[0];
    if (!org) throw AppError.notFound('Organization not found');
    return org;
  } catch (err) {
    if (isPostgresError(err) && err.code === '23505') {
      throw AppError.conflict('Slug already taken');
    }
    throw err;
  }
}

export async function deleteOrganization(db: Sql, orgId: string): Promise<void> {
  await db.begin(async (tx: TransactionSql) => {
    const rows = await (tx as unknown as Sql)<[{ id: string }]>`
      UPDATE organizations
      SET is_active = false
      WHERE id = ${orgId}
      RETURNING id
    `;

    const org = rows[0];
    if (!org) throw AppError.notFound('Organization not found');

    await (tx as unknown as Sql)`
      UPDATE users
      SET is_active = false
      WHERE org_id = ${orgId}
    `;
  });
}
