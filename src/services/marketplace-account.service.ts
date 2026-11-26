import { randomBytes } from 'crypto';
import type { Sql, TransactionSql } from 'postgres';
import { AppError, ErrorCodes } from '@utils/errors';
import { uniqueViolationConstraint } from '@utils/postgres-errors';
import {
  insertOrganizationWithAdmin,
  toOrganizationConflictError,
} from '@services/organization.service';
import {
  findUsableRegistration,
  markRegistrationConsumed,
  type MarketplaceRegistration,
} from '@services/marketplace-registration.service';

/** Org slugs are lowercase letters, digits and dashes, at most 100 characters. */
const SLUG_BASE_MAX_LENGTH = 80;
const SLUG_SUFFIX_BYTES = 3;

export interface LinkedMarketplaceCustomer {
  organizationId: string;
  customerId: string;
}

export interface MarketplaceSignup {
  organizationName: string;
  adminEmail: string;
  adminPassword: string;
}

/** Builds a unique-enough slug such as `acme-security-3f9a1c` from an org name. */
export function slugFromOrganizationName(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_BASE_MAX_LENGTH)
      .replace(/-+$/g, '') || 'org';
  return `${base}-${randomBytes(SLUG_SUFFIX_BYTES).toString('hex')}`;
}

export async function isAwsAccountLinked(db: Sql, awsAccountId: string): Promise<boolean> {
  const rows = await db`
    SELECT 1 FROM marketplace_customers WHERE aws_account_id = ${awsAccountId}
  `;
  return rows.length > 0;
}

async function assertAwsAccountNotLinked(tx: TransactionSql, awsAccountId: string): Promise<void> {
  const rows = await (tx as unknown as Sql)`
    SELECT 1 FROM marketplace_customers WHERE aws_account_id = ${awsAccountId}
  `;
  if (rows.length > 0) {
    throw new AppError(
      ErrorCodes.MARKETPLACE_ACCOUNT_ALREADY_LINKED,
      'This AWS account is already linked to an organization. Sign in to that organization instead.',
      409,
    );
  }
}

async function assertOrgNotLinked(tx: TransactionSql, orgId: string): Promise<void> {
  const rows = await (tx as unknown as Sql)`
    SELECT 1 FROM marketplace_customers WHERE org_id = ${orgId}
  `;
  if (rows.length > 0) {
    throw new AppError(
      ErrorCodes.ORG_ALREADY_LINKED,
      'This organization is already linked to an AWS Marketplace subscription',
      409,
    );
  }
}

async function insertMarketplaceCustomer(
  tx: TransactionSql,
  orgId: string,
  registration: MarketplaceRegistration,
): Promise<string> {
  const rows = await (tx as unknown as Sql)<[{ id: string }]>`
    INSERT INTO marketplace_customers (org_id, aws_account_id, license_arn, product_code, agreement_id)
    VALUES (${orgId}, ${registration.aws_account_id}, ${registration.license_arn},
            ${registration.product_code}, ${registration.agreement_id})
    RETURNING id
  `;
  return rows[0].id;
}

/**
 * Two requests racing past the checks above still hit the unique constraints on
 * marketplace_customers; report those as the same 409s.
 */
function toLinkConflictError(err: unknown): unknown {
  const constraint = uniqueViolationConstraint(err);
  if (constraint === null) return err;
  if (constraint.includes('aws_account_id')) {
    return new AppError(
      ErrorCodes.MARKETPLACE_ACCOUNT_ALREADY_LINKED,
      'This AWS account is already linked to an organization',
      409,
    );
  }
  if (constraint.includes('org_id')) {
    return new AppError(
      ErrorCodes.ORG_ALREADY_LINKED,
      'This organization is already linked to an AWS Marketplace subscription',
      409,
    );
  }
  return err;
}

/** New buyer: creates the org and its Org Admin, and links the AWS account to it. */
export async function signUpFromRegistration(
  db: Sql,
  reference: string,
  signup: MarketplaceSignup,
): Promise<LinkedMarketplaceCustomer> {
  try {
    const result = await db.begin(async (tx: TransactionSql) => {
      const registration = await findUsableRegistration(tx, reference, { lock: true });
      await assertAwsAccountNotLinked(tx, registration.aws_account_id);

      const org = await insertOrganizationWithAdmin(tx, {
        name: signup.organizationName,
        slug: slugFromOrganizationName(signup.organizationName),
        adminEmail: signup.adminEmail,
        adminPassword: signup.adminPassword,
      });
      const customerId = await insertMarketplaceCustomer(tx, org.id, registration);
      await markRegistrationConsumed(tx, registration.id);

      return { organizationId: org.id, customerId };
    });
    return result as LinkedMarketplaceCustomer;
  } catch (err) {
    throw toOrganizationConflictError(toLinkConflictError(err));
  }
}

/** Existing customer: an Org Admin attaches the AWS purchase to their own org. */
export async function linkRegistrationToOrg(
  db: Sql,
  reference: string,
  orgId: string,
): Promise<LinkedMarketplaceCustomer> {
  try {
    const result = await db.begin(async (tx: TransactionSql) => {
      const registration = await findUsableRegistration(tx, reference, { lock: true });
      await assertAwsAccountNotLinked(tx, registration.aws_account_id);
      await assertOrgNotLinked(tx, orgId);

      const customerId = await insertMarketplaceCustomer(tx, orgId, registration);
      await markRegistrationConsumed(tx, registration.id);

      return { organizationId: orgId, customerId };
    });
    return result as LinkedMarketplaceCustomer;
  } catch (err) {
    throw toLinkConflictError(err);
  }
}
