import { createHash, randomBytes } from 'crypto';
import type { Sql, TransactionSql } from 'postgres';
import {
  ResolveCustomerCommand,
  type MarketplaceMeteringClient,
} from '@aws-sdk/client-marketplace-metering';
import { AppError, ErrorCodes } from '@utils/errors';

/** 32 random bytes → 43 base64url characters. */
const REFERENCE_BYTES = 32;
export const REFERENCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Why a registration token from AWS could not be used; sent to the website as `?error=`. */
export type RegistrationTokenProblem = 'token_expired' | 'token_invalid' | 'wrong_product';

export class RegistrationTokenError extends Error {
  constructor(public readonly problem: RegistrationTokenProblem) {
    super(`AWS Marketplace registration token rejected: ${problem}`);
    this.name = 'RegistrationTokenError';
  }
}

export interface ResolvedMarketplaceCustomer {
  awsAccountId: string;
  licenseArn: string | null;
  productCode: string;
  agreementId: string | null;
}

export interface MarketplaceRegistration {
  id: string;
  aws_account_id: string;
  license_arn: string | null;
  product_code: string;
  agreement_id: string | null;
  is_free_trial: boolean;
  expires_at: Date;
  consumed_at: Date | null;
}

/** AWS error names that mean the buyer has to start again from AWS Marketplace. */
const TOKEN_ERROR_PROBLEMS: Record<string, RegistrationTokenProblem> = {
  ExpiredTokenException: 'token_expired',
  InvalidTokenException: 'token_invalid',
};

/**
 * Exchanges the `x-amzn-marketplace-token` for the buyer's identity.
 * Must run as soon as the token arrives: AWS expires it quickly and a resubmitted
 * token is rejected. New integrations get CustomerAWSAccountId + LicenseArn
 * (CustomerIdentifier is no longer populated).
 */
export async function resolveRegistrationToken(
  client: MarketplaceMeteringClient,
  registrationToken: string,
  expectedProductCode: string,
): Promise<ResolvedMarketplaceCustomer> {
  let response;
  try {
    response = await client.send(
      new ResolveCustomerCommand({ RegistrationToken: registrationToken }),
    );
  } catch (err) {
    const problem = err instanceof Error ? TOKEN_ERROR_PROBLEMS[err.name] : undefined;
    if (problem) throw new RegistrationTokenError(problem);
    throw err;
  }

  if (!response.CustomerAWSAccountId || !response.ProductCode) {
    throw new RegistrationTokenError('token_invalid');
  }

  // Guards against a token minted for a different product in the same seller account.
  if (response.ProductCode !== expectedProductCode) {
    throw new RegistrationTokenError('wrong_product');
  }

  return {
    awsAccountId: response.CustomerAWSAccountId,
    licenseArn: response.LicenseArn ?? null,
    productCode: response.ProductCode,
    agreementId: response.Metadata?.AgreementId ?? null,
  };
}

export function hashReference(reference: string): string {
  return createHash('sha256').update(reference).digest('hex');
}

/**
 * Stores a resolved buyer as a pending registration and returns the one-time
 * reference the website will carry. Only the hash is stored.
 */
export async function createPendingRegistration(
  db: Sql,
  customer: ResolvedMarketplaceCustomer,
  options: { isFreeTrial: boolean; ttlMinutes: number },
): Promise<string> {
  const reference = randomBytes(REFERENCE_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + options.ttlMinutes * 60_000);

  await db`
    INSERT INTO marketplace_registrations
      (reference_hash, aws_account_id, license_arn, product_code, agreement_id,
       is_free_trial, expires_at)
    VALUES
      (${hashReference(reference)}, ${customer.awsAccountId}, ${customer.licenseArn},
       ${customer.productCode}, ${customer.agreementId}, ${options.isFreeTrial}, ${expiresAt})
  `;

  return reference;
}

/**
 * Loads a registration that can still be used. Pass a transaction to lock the row
 * (`FOR UPDATE`) so two signups cannot consume the same reference.
 */
export async function findUsableRegistration(
  db: Sql | TransactionSql,
  reference: string,
  options: { lock: boolean } = { lock: false },
): Promise<MarketplaceRegistration> {
  const sql = db as unknown as Sql;
  const lockClause = options.lock ? sql`FOR UPDATE` : sql``;
  const rows = await sql<MarketplaceRegistration[]>`
    SELECT id, aws_account_id, license_arn, product_code, agreement_id,
           is_free_trial, expires_at, consumed_at
    FROM marketplace_registrations
    WHERE reference_hash = ${hashReference(reference)}
    ${lockClause}
  `;

  const registration = rows[0];
  if (!registration || registration.consumed_at) {
    throw new AppError(
      ErrorCodes.MARKETPLACE_REGISTRATION_NOT_FOUND,
      'Registration not found or already used',
      404,
    );
  }
  if (registration.expires_at.getTime() <= Date.now()) {
    throw new AppError(
      ErrorCodes.MARKETPLACE_REGISTRATION_EXPIRED,
      'Registration has expired. Open the product again from AWS Marketplace.',
      410,
    );
  }
  return registration;
}

export async function markRegistrationConsumed(
  tx: TransactionSql,
  registrationId: string,
): Promise<void> {
  await (tx as unknown as Sql)`
    UPDATE marketplace_registrations SET consumed_at = now() WHERE id = ${registrationId}
  `;
}
