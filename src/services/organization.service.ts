import type { Sql, TransactionSql } from 'postgres';
import { hashPassword } from '@utils/password';
import { AppError } from '@utils/errors';
import { uniqueViolationConstraint } from '@utils/postgres-errors';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  camera_seq: number;
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
    SELECT id, name, slug, is_active, camera_seq, created_at, updated_at
    FROM organizations
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return { data, pagination: { page, limit, total } };
}

export interface NewOrganizationWithAdmin {
  name: string;
  slug: string;
  adminEmail: string;
  adminPassword: string;
}

/**
 * Inserts an organization and its first org_admin inside a caller-owned transaction,
 * so other flows (e.g. AWS Marketplace signup) can add their own rows atomically.
 */
export async function insertOrganizationWithAdmin(
  tx: TransactionSql,
  params: NewOrganizationWithAdmin,
): Promise<Organization> {
  const sql = tx as unknown as Sql;
  const orgRows = await sql<Organization[]>`
    INSERT INTO organizations (name, slug)
    VALUES (${params.name}, ${params.slug})
    RETURNING id, name, slug, is_active, camera_seq, created_at, updated_at
  `;

  const org = orgRows[0];
  if (!org) throw new Error('Failed to create organization');

  const passwordHash = await hashPassword(params.adminPassword);

  await sql`
    INSERT INTO users (email, password_hash, role, org_id)
    VALUES (${params.adminEmail}, ${passwordHash}, 'org_admin', ${org.id})
  `;

  return org;
}

/** Maps unique-constraint violations from org/admin creation to API errors. */
export function toOrganizationConflictError(err: unknown): unknown {
  const constraint = uniqueViolationConstraint(err);
  if (constraint === null) return err;
  if (constraint.includes('email')) return AppError.conflict('Email already registered');
  if (constraint.includes('slug')) return AppError.conflict('Slug already taken');
  return err;
}

export async function createOrganizationWithAdmin(
  db: Sql,
  params: NewOrganizationWithAdmin,
): Promise<Organization> {
  try {
    const result = await db.begin((tx: TransactionSql) => insertOrganizationWithAdmin(tx, params));
    return result as Organization;
  } catch (err) {
    throw toOrganizationConflictError(err);
  }
}

export async function getOrganizationById(db: Sql, orgId: string): Promise<Organization> {
  const rows = await db<Organization[]>`
    SELECT id, name, slug, is_active, camera_seq, created_at, updated_at
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
      RETURNING id, name, slug, is_active, camera_seq, created_at, updated_at
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
