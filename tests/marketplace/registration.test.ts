import { mockClient } from 'aws-sdk-client-mock';
import {
  ExpiredTokenException,
  InvalidTokenException,
  MarketplaceMeteringClient,
  ResolveCustomerCommand,
} from '@aws-sdk/client-marketplace-metering';
import {
  GetEntitlementsCommand,
  MarketplaceEntitlementServiceClient,
} from '@aws-sdk/client-marketplace-entitlement-service';
import type { FastifyInstance } from 'fastify';
import { env } from '../../src/config/env';
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';

const meteringMock = mockClient(MarketplaceMeteringClient);
const entitlementMock = mockClient(MarketplaceEntitlementServiceClient);

const CAMERA_LIMIT = 10;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
let accountCounter = 0;

/** Placeholder 12-digit AWS account IDs, unique per test run. */
function placeholderAwsAccountId(): string {
  accountCounter += 1;
  return `9${String(Date.now()).slice(-8)}${String(accountCounter).padStart(3, '0')}`;
}

function mockResolveCustomer(awsAccountId: string, productCode = env.MARKETPLACE_PRODUCT_CODE) {
  meteringMock.on(ResolveCustomerCommand).resolves({
    CustomerAWSAccountId: awsAccountId,
    ProductCode: productCode,
    LicenseArn: `arn:aws:license-manager::${awsAccountId}:license:l-example`,
    Metadata: { AgreementId: 'agmt-example' },
  });
}

function mockValidEntitlement() {
  entitlementMock.on(GetEntitlementsCommand).resolves({
    Entitlements: [
      {
        Dimension: env.MARKETPLACE_CAMERA_DIMENSION,
        Value: { IntegerValue: CAMERA_LIMIT },
        ExpirationDate: new Date(Date.now() + ONE_YEAR_MS),
      },
    ],
  });
}

function postRegistrationToken(app: FastifyInstance, token = 'example-token', offerType?: string) {
  const form = new URLSearchParams({ 'x-amzn-marketplace-token': token });
  if (offerType) form.set('x-amzn-marketplace-offer-type', offerType);
  return app.inject({
    method: 'POST',
    url: '/api/v1/marketplace/register',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form.toString(),
  });
}

function redirectQuery(location: string | undefined): URLSearchParams {
  return new URL(location ?? '').searchParams;
}

/** Runs the AWS → API step and returns the one-time reference the website receives. */
async function startRegistration(app: FastifyInstance, awsAccountId: string): Promise<string> {
  mockResolveCustomer(awsAccountId);
  const res = await postRegistrationToken(app);
  const reference = redirectQuery(res.headers.location as string).get('ref');
  if (!reference) throw new Error(`No reference in redirect: ${res.headers.location}`);
  return reference;
}

const ADMIN_PASSWORD = 'password123!';

function signUp(
  app: FastifyInstance,
  reference: string,
  suffix: string,
  adminEmail = `marketplace-${suffix}-${Date.now()}@example.com`,
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/marketplace/registrations/${reference}/signup`,
    payload: {
      organizationName: `Example Security ${suffix}`,
      adminEmail,
      adminPassword: ADMIN_PASSWORD,
    },
  });
}

function link(app: FastifyInstance, reference: string, accessToken?: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/marketplace/registrations/${reference}/link`,
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
}

describe('AWS Marketplace registration', () => {
  let app: FastifyInstance;
  let superAdminToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);
  });

  beforeEach(() => {
    meteringMock.reset();
    entitlementMock.reset();
    mockValidEntitlement();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('POST /api/v1/marketplace/register', () => {
    it('resolves the token and redirects to the website with a one-time reference', async () => {
      const awsAccountId = placeholderAwsAccountId();
      mockResolveCustomer(awsAccountId);

      const res = await postRegistrationToken(app, 'example-token', 'free-trial');

      expect(res.statusCode).toBe(303);
      const location = res.headers.location as string;
      expect(location.startsWith(env.MARKETPLACE_REGISTRATION_PAGE_URL)).toBe(true);
      const reference = redirectQuery(location).get('ref');
      expect(reference).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(location).not.toContain(awsAccountId);
      expect(meteringMock.commandCalls(ResolveCustomerCommand)[0]?.args[0].input).toEqual({
        RegistrationToken: 'example-token',
      });

      const rows = await app.db<{ reference_hash: string; is_free_trial: boolean }[]>`
        SELECT reference_hash, is_free_trial FROM marketplace_registrations
        WHERE aws_account_id = ${awsAccountId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reference_hash).not.toBe(reference);
      expect(rows[0]?.is_free_trial).toBe(true);
    });

    it.each([
      ['token_expired', new ExpiredTokenException({ message: 'expired', $metadata: {} })],
      ['token_invalid', new InvalidTokenException({ message: 'invalid', $metadata: {} })],
    ])('redirects with error=%s when AWS rejects the token', async (problem, awsError) => {
      meteringMock.on(ResolveCustomerCommand).rejects(awsError);

      const res = await postRegistrationToken(app);

      expect(res.statusCode).toBe(303);
      expect(redirectQuery(res.headers.location as string).get('error')).toBe(problem);
    });

    it('redirects with error=wrong_product for a token from another product', async () => {
      mockResolveCustomer(placeholderAwsAccountId(), 'some-other-product');

      const res = await postRegistrationToken(app);

      expect(redirectQuery(res.headers.location as string).get('error')).toBe('wrong_product');
    });

    it('redirects with error=token_invalid when no token is posted', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/marketplace/register',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });

      expect(res.statusCode).toBe(303);
      expect(redirectQuery(res.headers.location as string).get('error')).toBe('token_invalid');
      expect(meteringMock.commandCalls(ResolveCustomerCommand)).toHaveLength(0);
    });

    it('redirects with error=unavailable when AWS is down', async () => {
      meteringMock.on(ResolveCustomerCommand).rejects(new Error('network down'));

      const res = await postRegistrationToken(app);

      expect(redirectQuery(res.headers.location as string).get('error')).toBe('unavailable');
    });
  });

  describe('GET /api/v1/marketplace/registrations/:reference', () => {
    it('returns the pending registration', async () => {
      const reference = await startRegistration(app, placeholderAwsAccountId());

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/marketplace/registrations/${reference}`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ isFreeTrial: false, awsAccountAlreadyLinked: false });
    });

    it('returns 404 for an unknown reference and 400 for a malformed one', async () => {
      const unknown = await app.inject({
        method: 'GET',
        url: `/api/v1/marketplace/registrations/${'A'.repeat(43)}`,
      });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe('MARKETPLACE_REGISTRATION_NOT_FOUND');

      const malformed = await app.inject({
        method: 'GET',
        url: '/api/v1/marketplace/registrations/not-a-reference',
      });
      expect(malformed.statusCode).toBe(400);
    });

    it('returns 410 once the reference has expired', async () => {
      const awsAccountId = placeholderAwsAccountId();
      const reference = await startRegistration(app, awsAccountId);
      await app.db`
        UPDATE marketplace_registrations SET expires_at = now() - interval '1 minute'
        WHERE aws_account_id = ${awsAccountId}
      `;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/marketplace/registrations/${reference}`,
      });

      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe('MARKETPLACE_REGISTRATION_EXPIRED');
    });
  });

  describe('POST /api/v1/marketplace/registrations/:reference/signup', () => {
    it('creates an active org with the contract camera limit, and the admin can log in', async () => {
      const awsAccountId = placeholderAwsAccountId();
      const reference = await startRegistration(app, awsAccountId);

      const adminEmail = `marketplace-new-${Date.now()}@example.com`;
      const res = await signUp(app, reference, 'new', adminEmail);

      expect(res.statusCode).toBe(201);
      const body = res.json<{ organizationId: string; subscriptionStatus: string }>();
      expect(body.subscriptionStatus).toBe('active');

      const customers = await app.db<{ org_id: string; camera_limit: number }[]>`
        SELECT org_id, camera_limit FROM marketplace_customers WHERE aws_account_id = ${awsAccountId}
      `;
      expect(customers[0]).toEqual({ org_id: body.organizationId, camera_limit: CAMERA_LIMIT });
      expect(entitlementMock.commandCalls(GetEntitlementsCommand)[0]?.args[0].input.Filter).toEqual(
        { CUSTOMER_AWS_ACCOUNT_ID: [awsAccountId] },
      );

      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: adminEmail, password: ADMIN_PASSWORD },
      });
      expect(login.statusCode).toBe(200);
    });

    it('keeps the org pending when AWS has not confirmed the license yet', async () => {
      entitlementMock.on(GetEntitlementsCommand).resolves({ Entitlements: [] });
      const reference = await startRegistration(app, placeholderAwsAccountId());

      const res = await signUp(app, reference, 'pending');

      expect(res.statusCode).toBe(201);
      expect(res.json().subscriptionStatus).toBe('pending_activation');
    });

    it('still creates the org when the entitlement check fails', async () => {
      entitlementMock.on(GetEntitlementsCommand).rejects(new Error('throttled'));
      const reference = await startRegistration(app, placeholderAwsAccountId());

      const res = await signUp(app, reference, 'aws-down');

      expect(res.statusCode).toBe(201);
      expect(res.json().subscriptionStatus).toBe('pending_activation');
    });

    it('cannot reuse a reference', async () => {
      const reference = await startRegistration(app, placeholderAwsAccountId());
      expect((await signUp(app, reference, 'first')).statusCode).toBe(201);

      const second = await signUp(app, reference, 'second');

      expect(second.statusCode).toBe(404);
      expect(second.json().error.code).toBe('MARKETPLACE_REGISTRATION_NOT_FOUND');
    });

    it('lets only one of two simultaneous signups use a reference', async () => {
      const reference = await startRegistration(app, placeholderAwsAccountId());

      const results = await Promise.all([
        signUp(app, reference, 'race-a'),
        signUp(app, reference, 'race-b'),
      ]);

      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 404]);
    });

    it('refuses a second org for an AWS account that is already linked', async () => {
      const awsAccountId = placeholderAwsAccountId();
      const firstReference = await startRegistration(app, awsAccountId);
      expect((await signUp(app, firstReference, 'owner')).statusCode).toBe(201);

      const secondReference = await startRegistration(app, awsAccountId);
      const res = await signUp(app, secondReference, 'duplicate');

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('MARKETPLACE_ACCOUNT_ALREADY_LINKED');
    });
  });

  describe('POST /api/v1/marketplace/registrations/:reference/link', () => {
    it('links the purchase to the signed-in Org Admin org', async () => {
      const org = await createOrgAndLogin(app, superAdminToken, 'mp-link');
      const reference = await startRegistration(app, placeholderAwsAccountId());

      const res = await link(app, reference, org.orgAdminAccessToken);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ organizationId: org.orgId, subscriptionStatus: 'active' });
    });

    it('requires a signed-in Org Admin', async () => {
      const org = await createOrgAndLogin(app, superAdminToken, 'mp-viewer');
      const viewerEmail = `mp-viewer-${Date.now()}@example.com`;
      await app.inject({
        method: 'POST',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${org.orgAdminAccessToken}` },
        payload: { email: viewerEmail, password: 'password123!' },
      });
      const viewerLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: viewerEmail, password: 'password123!' },
      });
      const reference = await startRegistration(app, placeholderAwsAccountId());

      expect((await link(app, reference)).statusCode).toBe(401);
      expect((await link(app, reference, viewerLogin.json().accessToken)).statusCode).toBe(403);
      expect((await link(app, reference, superAdminToken)).statusCode).toBe(403);
    });

    it('refuses to link a second AWS account to the same org', async () => {
      const org = await createOrgAndLogin(app, superAdminToken, 'mp-twice');
      const first = await startRegistration(app, placeholderAwsAccountId());
      expect((await link(app, first, org.orgAdminAccessToken)).statusCode).toBe(200);

      const second = await startRegistration(app, placeholderAwsAccountId());
      const res = await link(app, second, org.orgAdminAccessToken);

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('ORG_ALREADY_LINKED');
    });

    it('cross-org: an AWS account linked to org A cannot be linked to org B', async () => {
      const orgA = await createOrgAndLogin(app, superAdminToken, 'mp-org-a');
      const orgB = await createOrgAndLogin(app, superAdminToken, 'mp-org-b');
      const awsAccountId = placeholderAwsAccountId();

      const referenceA = await startRegistration(app, awsAccountId);
      expect((await link(app, referenceA, orgA.orgAdminAccessToken)).statusCode).toBe(200);

      const referenceB = await startRegistration(app, awsAccountId);
      const res = await link(app, referenceB, orgB.orgAdminAccessToken);

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('MARKETPLACE_ACCOUNT_ALREADY_LINKED');
      const owners = await app.db<{ org_id: string }[]>`
        SELECT org_id FROM marketplace_customers WHERE aws_account_id = ${awsAccountId}
      `;
      expect(owners).toEqual([{ org_id: orgA.orgId }]);
    });
  });
});
