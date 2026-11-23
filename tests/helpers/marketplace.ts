import { randomUUID } from 'crypto';
import type { AwsStub } from 'aws-sdk-client-mock';
import {
  GetEntitlementsCommand,
  type Entitlement,
  type MarketplaceEntitlementServiceClient,
  type ServiceInputTypes,
  type ServiceOutputTypes,
} from '@aws-sdk/client-marketplace-entitlement-service';
import {
  ResolveCustomerCommand,
  type MarketplaceMeteringClient,
  type ServiceInputTypes as MeteringInputTypes,
  type ServiceOutputTypes as MeteringOutputTypes,
} from '@aws-sdk/client-marketplace-metering';
import type { FastifyInstance } from 'fastify';
import { env } from '../../src/config/env';

export const INTERNAL_SECRET = process.env['INTERNAL_API_SECRET'] ?? '';
export const ADMIN_PASSWORD = 'password123!';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Placeholder AWS account / proposer used in every fixture (not a real account). */
const SELLER_ACCOUNT_ID = '111122223333';
const PRODUCT_ID = 'prod-example0000000';

let accountCounter = 0;

/** Made-up 12-digit AWS account IDs, unique per test run. */
export function placeholderAwsAccountId(): string {
  accountCounter += 1;
  return `8${String(Date.now()).slice(-8)}${String(accountCounter).padStart(3, '0')}`;
}

export function placeholderAgreementId(): string {
  return `agmt-${randomUUID().replace(/-/g, '').slice(0, 25)}`;
}

export type EntitlementMock = AwsStub<
  ServiceInputTypes,
  ServiceOutputTypes,
  MarketplaceEntitlementServiceClient['config']
>;
export type MeteringMock = AwsStub<
  MeteringInputTypes,
  MeteringOutputTypes,
  MarketplaceMeteringClient['config']
>;

/**
 * Fake AWS: what GetEntitlements returns for each buyer account. Accounts not in
 * the map have no entitlements; an Error value makes the call fail.
 */
export class FakeEntitlements {
  private readonly byAccount = new Map<string, Entitlement[] | Error>();

  constructor(private readonly mock: EntitlementMock) {}

  install(): void {
    this.mock
      .on(GetEntitlementsCommand)
      .callsFake((input: { Filter?: Record<string, string[]> }) => {
        const accountId = input.Filter?.['CUSTOMER_AWS_ACCOUNT_ID']?.[0] ?? '';
        const value = this.byAccount.get(accountId) ?? [];
        if (value instanceof Error) throw value;
        return { Entitlements: value };
      });
  }

  setCameras(awsAccountId: string, cameraLimit: number, expiresAt?: Date): void {
    this.byAccount.set(awsAccountId, [cameraEntitlement(cameraLimit, expiresAt)]);
  }

  set(awsAccountId: string, entitlements: Entitlement[]): void {
    this.byAccount.set(awsAccountId, entitlements);
  }

  remove(awsAccountId: string): void {
    this.byAccount.set(awsAccountId, []);
  }

  fail(awsAccountId: string): void {
    this.byAccount.set(awsAccountId, new Error('Simulated AWS outage'));
  }

  /** Account IDs GetEntitlements was asked about, in call order. */
  queriedAccounts(): string[] {
    return this.mock
      .commandCalls(GetEntitlementsCommand)
      .map((call) => call.args[0].input.Filter?.['CUSTOMER_AWS_ACCOUNT_ID']?.[0] ?? '');
  }
}

export function cameraEntitlement(
  cameraLimit: number,
  expiresAt = new Date(Date.now() + ONE_YEAR_MS),
): Entitlement {
  return {
    Dimension: env.MARKETPLACE_CAMERA_DIMENSION,
    Value: { IntegerValue: cameraLimit },
    ExpirationDate: expiresAt,
  };
}

interface EventOptions {
  awsAccountId: string;
  agreementId?: string;
  eventId?: string;
  time?: string;
}

/**
 * An EventBridge event shaped like AWS's documented AWS Marketplace agreement
 * and license examples. All identifiers are placeholders.
 */
export function marketplaceEvent(detailType: string, options: EventOptions) {
  const agreementId = options.agreementId ?? placeholderAgreementId();
  const isLicenseEvent = detailType.startsWith('License ');

  return {
    version: '0',
    id: options.eventId ?? randomUUID(),
    'detail-type': detailType,
    source: 'aws.agreement-marketplace',
    account: SELLER_ACCOUNT_ID,
    time: options.time ?? new Date().toISOString(),
    region: 'us-east-1',
    resources: [
      `arn:aws:aws-marketplace:us-east-1:${SELLER_ACCOUNT_ID}:AWSMarketplace/Agreement/${agreementId}`,
    ],
    detail: {
      requestId: randomUUID(),
      agreement: {
        id: agreementId,
        intent: 'NEW',
        status: 'ACTIVE',
        createdTime: '2026-01-01T00:00:00Z',
        startTime: '2026-01-01T00:00:00Z',
        endTime: '2027-01-01T00:00:00Z',
      },
      product: { id: PRODUCT_ID, code: env.MARKETPLACE_PRODUCT_CODE, title: 'Example product' },
      ...(isLicenseEvent
        ? {
            // AWS's example license ARN has no `arn:` prefix; we store it as-is.
            license: {
              arn: `aws:license-manager::${SELLER_ACCOUNT_ID}:license:l-example000000000`,
              status: 'AVAILABLE',
            },
          }
        : {}),
      acceptor: { accountId: options.awsAccountId },
      proposer: { accountId: SELLER_ACCOUNT_ID },
      offer: { id: 'offer-example00000000' },
    },
  };
}

export function postEvent(app: FastifyInstance, event: unknown, secret = INTERNAL_SECRET) {
  return app.inject({
    method: 'POST',
    url: '/internal/marketplace/events',
    headers: { 'x-internal-secret': secret },
    payload: event as Record<string, unknown>,
  });
}

export function postReconcile(app: FastifyInstance, secret = INTERNAL_SECRET) {
  return app.inject({
    method: 'POST',
    url: '/internal/marketplace/reconcile',
    headers: { 'x-internal-secret': secret },
  });
}

export interface MarketplaceOrg {
  orgId: string;
  awsAccountId: string;
  adminEmail: string;
  accessToken: string;
  refreshToken: string;
}

export function login(app: FastifyInstance, email: string, password = ADMIN_PASSWORD) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
}

/**
 * Runs the full buyer journey: AWS fulfillment POST → website signup → login.
 * The org's status depends on what `FakeEntitlements` holds for the account.
 */
export async function signUpMarketplaceOrg(
  app: FastifyInstance,
  meteringMock: MeteringMock,
  awsAccountId: string,
  suffix: string,
): Promise<MarketplaceOrg> {
  meteringMock.on(ResolveCustomerCommand).resolves({
    CustomerAWSAccountId: awsAccountId,
    ProductCode: env.MARKETPLACE_PRODUCT_CODE,
    LicenseArn: `arn:aws:license-manager::${awsAccountId}:license:l-example`,
    Metadata: { AgreementId: placeholderAgreementId() },
  });
  const registerRes = await app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/register',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ 'x-amzn-marketplace-token': 'example-token' }).toString(),
  });
  const reference = new URL(registerRes.headers.location as string).searchParams.get('ref');
  if (!reference) throw new Error(`No reference in redirect: ${registerRes.headers.location}`);

  const adminEmail = `mp-events-${suffix}-${Date.now()}@example.com`;
  const signupRes = await app.inject({
    method: 'POST',
    url: `/api/v1/marketplace/registrations/${reference}/signup`,
    payload: {
      organizationName: `Example Events ${suffix}`,
      adminEmail,
      adminPassword: ADMIN_PASSWORD,
    },
  });
  if (signupRes.statusCode !== 201) {
    throw new Error(`Signup failed: ${signupRes.statusCode} ${signupRes.body}`);
  }
  const { organizationId } = signupRes.json<{ organizationId: string }>();

  const loginRes = await login(app, adminEmail);
  if (loginRes.statusCode !== 200) {
    throw new Error(`Login failed: ${loginRes.statusCode} ${loginRes.body}`);
  }
  const tokens = loginRes.json<{ accessToken: string; refreshToken: string }>();

  return { orgId: organizationId, awsAccountId, adminEmail, ...tokens };
}
