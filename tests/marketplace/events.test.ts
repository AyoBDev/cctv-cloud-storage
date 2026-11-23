import { mockClient } from 'aws-sdk-client-mock';
import { MarketplaceMeteringClient } from '@aws-sdk/client-marketplace-metering';
import { MarketplaceEntitlementServiceClient } from '@aws-sdk/client-marketplace-entitlement-service';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import {
  FakeEntitlements,
  login,
  marketplaceEvent,
  placeholderAgreementId,
  placeholderAwsAccountId,
  postEvent,
  postReconcile,
  signUpMarketplaceOrg,
  type MarketplaceOrg,
} from '../helpers/marketplace';

const meteringMock = mockClient(MarketplaceMeteringClient);
const entitlementMock = mockClient(MarketplaceEntitlementServiceClient);

const CREATED = 'Purchase Agreement Created - Manufacturer';
const AMENDED = 'Purchase Agreement Amended - Manufacturer';
const ENDED = 'Purchase Agreement Ended - Manufacturer';
const ENDED_PROPOSER = 'Purchase Agreement Ended - Proposer';
const LICENSE_UPDATED = 'License Updated - Manufacturer';
const LICENSE_DEPROVISIONED = 'License Deprovisioned - Manufacturer';
const UNHANDLED = 'Example Unhandled Detail - Manufacturer';

interface StoredEvent {
  event_id: string;
  detail_type: string;
  agreement_id: string | null;
  license_arn: string | null;
  aws_account_id: string | null;
  processed_at: Date | null;
  error: string | null;
}

interface CustomerRow {
  status: string;
  camera_limit: number;
}

describe('AWS Marketplace events, access and camera limits', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let aws: FakeEntitlements;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);
  });

  beforeEach(() => {
    meteringMock.reset();
    entitlementMock.reset();
    aws = new FakeEntitlements(entitlementMock);
    aws.install();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  async function storedEvents(eventId: string): Promise<StoredEvent[]> {
    return app.db<StoredEvent[]>`
      SELECT event_id, detail_type, agreement_id, license_arn, aws_account_id, processed_at, error
      FROM marketplace_events WHERE event_id = ${eventId}
    `;
  }

  async function customerOf(orgId: string): Promise<CustomerRow> {
    const rows = await app.db<CustomerRow[]>`
      SELECT status, camera_limit FROM marketplace_customers WHERE org_id = ${orgId}
    `;
    if (!rows[0]) throw new Error(`No marketplace customer for org ${orgId}`);
    return rows[0];
  }

  /** A signed-up buyer whose AWS entitlement currently allows `cameraLimit` cameras. */
  async function activeOrg(suffix: string, cameraLimit = 10): Promise<MarketplaceOrg> {
    const awsAccountId = placeholderAwsAccountId();
    aws.setCameras(awsAccountId, cameraLimit);
    const org = await signUpMarketplaceOrg(app, meteringMock, awsAccountId, suffix);
    expect((await customerOf(org.orgId)).status).toBe('active');
    return org;
  }

  function listCameras(accessToken: string) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  function createCamera(accessToken: string, name: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name },
    });
  }

  function getSubscription(accessToken: string) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/org/subscription',
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  function refresh(refreshToken: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken },
    });
  }

  describe('internal route authentication', () => {
    const event = () => marketplaceEvent(CREATED, { awsAccountId: placeholderAwsAccountId() });

    it.each([
      ['events', (secret: string) => postEvent(app, event(), secret)],
      ['reconcile', (secret: string) => postReconcile(app, secret)],
    ])('POST /internal/marketplace/%s rejects a missing or wrong secret', async (_name, call) => {
      for (const secret of ['', 'wrong-secret-value-0000']) {
        const res = await call(secret);
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({
          error: { code: 'UNAUTHORIZED', message: expect.any(String) },
        });
      }
      expect(aws.queriedAccounts()).toEqual([]);
    });
  });

  describe('POST /internal/marketplace/events', () => {
    it('rejects events from any other source', async () => {
      const event = { ...marketplaceEvent(CREATED, { awsAccountId: placeholderAwsAccountId() }) };
      const res = await postEvent(app, { ...event, source: 'aws.example-other-source' });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
      expect(await storedEvents(event.id)).toHaveLength(0);
    });

    it('stores the agreement, license and buyer account from the event', async () => {
      const org = await activeOrg('fields');
      const agreementId = placeholderAgreementId();
      const event = marketplaceEvent(LICENSE_UPDATED, {
        awsAccountId: org.awsAccountId,
        agreementId,
      });

      const res = await postEvent(app, event);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: 'synced' });
      const [stored] = await storedEvents(event.id);
      expect(stored).toMatchObject({
        detail_type: LICENSE_UPDATED,
        agreement_id: agreementId,
        license_arn: event.detail.license?.arn,
        aws_account_id: org.awsAccountId,
        error: null,
      });
      expect(stored?.processed_at).toBeInstanceOf(Date);
    });

    it('stores a duplicate event once and does not sync it again', async () => {
      const org = await activeOrg('duplicate');
      const event = marketplaceEvent(CREATED, { awsAccountId: org.awsAccountId });
      entitlementMock.resetHistory();

      const first = await postEvent(app, event);
      const second = await postEvent(app, event);

      expect(first.json()).toEqual({ outcome: 'synced' });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ outcome: 'already_processed' });
      expect(await storedEvents(event.id)).toHaveLength(1);
      expect(aws.queriedAccounts()).toEqual([org.awsAccountId]);
    });

    it('ends in the state AWS reports, whatever order events arrive in', async () => {
      const org = await activeOrg('out-of-order');
      const agreementId = placeholderAgreementId();
      const created = marketplaceEvent(CREATED, {
        awsAccountId: org.awsAccountId,
        agreementId,
        time: '2026-01-01T00:00:00Z',
      });
      const ended = marketplaceEvent(ENDED, {
        awsAccountId: org.awsAccountId,
        agreementId,
        time: '2026-06-01T00:00:00Z',
      });
      aws.remove(org.awsAccountId);

      // The later "Ended" arrives first; the older "Created" arrives after it.
      expect((await postEvent(app, ended)).statusCode).toBe(200);
      expect((await postEvent(app, created)).statusCode).toBe(200);

      expect(await customerOf(org.orgId)).toEqual({ status: 'cancelled', camera_limit: 0 });
    });

    it('stores an event that arrives before signup, then signup activates the org', async () => {
      const awsAccountId = placeholderAwsAccountId();
      aws.setCameras(awsAccountId, 4);
      const event = marketplaceEvent(LICENSE_UPDATED, { awsAccountId });

      const res = await postEvent(app, event);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: 'no_customer' });
      const [stored] = await storedEvents(event.id);
      expect(stored?.aws_account_id).toBe(awsAccountId);
      expect(stored?.processed_at).toBeNull();
      expect(aws.queriedAccounts()).toEqual([]);

      const org = await signUpMarketplaceOrg(app, meteringMock, awsAccountId, 'early-event');
      expect(await customerOf(org.orgId)).toEqual({ status: 'active', camera_limit: 4 });
    });

    it('stores detail types it does not act on without calling AWS', async () => {
      const org = await activeOrg('unhandled');
      entitlementMock.resetHistory();
      const event = marketplaceEvent(UNHANDLED, { awsAccountId: org.awsAccountId });

      const res = await postEvent(app, event);

      expect(res.json()).toEqual({ outcome: 'ignored' });
      expect(await storedEvents(event.id)).toHaveLength(1);
      expect(aws.queriedAccounts()).toEqual([]);
    });

    it('acts on the Proposer variant of a detail type', async () => {
      const org = await activeOrg('proposer');
      aws.remove(org.awsAccountId);

      const res = await postEvent(
        app,
        marketplaceEvent(ENDED_PROPOSER, { awsAccountId: org.awsAccountId }),
      );

      expect(res.json()).toEqual({ outcome: 'synced' });
      expect((await customerOf(org.orgId)).status).toBe('cancelled');
    });

    it('records a failed AWS call, returns 503 so the queue retries, then succeeds on retry', async () => {
      const org = await activeOrg('retry', 3);
      aws.fail(org.awsAccountId);
      const event = marketplaceEvent(AMENDED, { awsAccountId: org.awsAccountId });

      const failed = await postEvent(app, event);

      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toEqual({
        error: { code: 'MARKETPLACE_SYNC_FAILED', message: expect.any(String) },
      });
      let [stored] = await storedEvents(event.id);
      expect(stored?.error).toBe('Simulated AWS outage');
      expect(stored?.processed_at).toBeNull();

      aws.setCameras(org.awsAccountId, 6);
      const retried = await postEvent(app, event);

      expect(retried.json()).toEqual({ outcome: 'synced' });
      [stored] = await storedEvents(event.id);
      expect(stored?.error).toBeNull();
      expect(stored?.processed_at).toBeInstanceOf(Date);
      expect(await customerOf(org.orgId)).toEqual({ status: 'active', camera_limit: 6 });
    });
  });

  describe('renewal and cancellation', () => {
    it('keeps a renewed customer active when the old agreement ends', async () => {
      const org = await activeOrg('renewal', 5);
      const oldAgreementId = placeholderAgreementId();
      // The renewal's entitlement is already in place when the old agreement ends.
      aws.setCameras(org.awsAccountId, 5, new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000));

      const res = await postEvent(
        app,
        marketplaceEvent(ENDED, { awsAccountId: org.awsAccountId, agreementId: oldAgreementId }),
      );

      expect(res.json()).toEqual({ outcome: 'synced' });
      expect(await customerOf(org.orgId)).toEqual({ status: 'active', camera_limit: 5 });
      expect((await listCameras(org.accessToken)).statusCode).toBe(200);
    });

    it.each([ENDED, LICENSE_DEPROVISIONED])(
      'blocks the next request and sign-in after "%s" leaves no entitlement',
      async (detailType) => {
        const org = await activeOrg(`cancel-${detailType.split(' ')[0]}`);
        // Warm the access cache so the test proves the event clears it.
        expect((await listCameras(org.accessToken)).statusCode).toBe(200);
        expect(await app.redis.get(`org-access:${org.orgId}`)).not.toBeNull();
        aws.remove(org.awsAccountId);

        await postEvent(app, marketplaceEvent(detailType, { awsAccountId: org.awsAccountId }));

        const next = await listCameras(org.accessToken);
        expect(next.statusCode).toBe(403);
        expect(next.json()).toEqual({
          error: { code: 'SUBSCRIPTION_INACTIVE', message: expect.any(String) },
        });
        const createRes = await createCamera(org.accessToken, 'After cancellation');
        expect(createRes.json<{ error: { code: string } }>().error.code).toBe(
          'SUBSCRIPTION_INACTIVE',
        );

        const loginRes = await login(app, org.adminEmail);
        expect(loginRes.statusCode).toBe(403);
        expect(loginRes.json<{ error: { code: string } }>().error.code).toBe(
          'SUBSCRIPTION_INACTIVE',
        );
        const refreshRes = await refresh(org.refreshToken);
        expect(refreshRes.statusCode).toBe(403);
        expect(refreshRes.json<{ error: { code: string } }>().error.code).toBe(
          'SUBSCRIPTION_INACTIVE',
        );

        const subscription = await getSubscription(org.accessToken);
        expect(subscription.statusCode).toBe(200);
        expect(subscription.json()).toEqual({
          source: 'aws_marketplace',
          status: 'cancelled',
          cameraLimit: 0,
          expiresAt: null,
        });
      },
    );

    it('lets a pending org sign in and read its subscription, but nothing else', async () => {
      const awsAccountId = placeholderAwsAccountId();
      const org = await signUpMarketplaceOrg(app, meteringMock, awsAccountId, 'pending');
      expect((await customerOf(org.orgId)).status).toBe('pending_activation');

      const res = await listCameras(org.accessToken);
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('SUBSCRIPTION_PENDING');
      expect((await refresh(org.refreshToken)).statusCode).toBe(200);
      expect((await getSubscription(org.accessToken)).json()).toMatchObject({
        source: 'aws_marketplace',
        status: 'pending_activation',
      });

      // AWS finishes provisioning the license.
      aws.setCameras(awsAccountId, 2);
      await postEvent(app, marketplaceEvent(LICENSE_UPDATED, { awsAccountId }));

      expect((await listCameras(org.accessToken)).statusCode).toBe(200);
    });
  });

  describe('camera limit', () => {
    it('follows upgrades and downgrades', async () => {
      const org = await activeOrg('upgrade', 5);

      aws.setCameras(org.awsAccountId, 20);
      await postEvent(app, marketplaceEvent(AMENDED, { awsAccountId: org.awsAccountId }));
      expect((await customerOf(org.orgId)).camera_limit).toBe(20);
      expect((await getSubscription(org.accessToken)).json()).toMatchObject({ cameraLimit: 20 });

      aws.setCameras(org.awsAccountId, 2);
      await postEvent(app, marketplaceEvent(AMENDED, { awsAccountId: org.awsAccountId }));
      expect(await customerOf(org.orgId)).toEqual({ status: 'active', camera_limit: 2 });
      expect((await getSubscription(org.accessToken)).json()).toMatchObject({ cameraLimit: 2 });
    });

    it('refuses cameras over the limit and keeps existing cameras after a downgrade', async () => {
      const org = await activeOrg('limit', 2);

      expect((await createCamera(org.accessToken, 'Camera 1')).statusCode).toBe(201);
      expect((await createCamera(org.accessToken, 'Camera 2')).statusCode).toBe(201);
      const overLimit = await createCamera(org.accessToken, 'Camera 3');
      expect(overLimit.statusCode).toBe(403);
      expect(overLimit.json()).toEqual({
        error: { code: 'CAMERA_LIMIT_REACHED', message: expect.any(String) },
      });

      aws.setCameras(org.awsAccountId, 1);
      await postEvent(app, marketplaceEvent(AMENDED, { awsAccountId: org.awsAccountId }));

      const list = await listCameras(org.accessToken);
      expect(list.statusCode).toBe(200);
      expect(list.json<{ pagination: { total: number } }>().pagination.total).toBe(2);
      expect((await createCamera(org.accessToken, 'Camera 3')).statusCode).toBe(403);

      aws.setCameras(org.awsAccountId, 3);
      await postEvent(app, marketplaceEvent(AMENDED, { awsAccountId: org.awsAccountId }));
      expect((await createCamera(org.accessToken, 'Camera 3')).statusCode).toBe(201);
    });
  });

  describe('POST /internal/marketplace/reconcile', () => {
    it('re-syncs every customer and counts checked, changed and failed', async () => {
      const upgraded = await activeOrg('reconcile-upgraded', 3);
      const failing = await activeOrg('reconcile-failing', 3);
      const unchangedExpiry = new Date('2030-01-01T00:00:00Z');
      const unchanged = await activeOrg('reconcile-unchanged', 3);
      aws.setCameras(unchanged.awsAccountId, 3, unchangedExpiry);

      // First run settles every customer from earlier tests and runs.
      const settle = await postReconcile(app);
      expect(settle.statusCode).toBe(200);

      aws.setCameras(upgraded.awsAccountId, 7);
      aws.fail(failing.awsAccountId);
      const res = await postReconcile(app);

      const [{ count }] = await app.db<[{ count: string }]>`
        SELECT COUNT(*) FROM marketplace_customers
      `;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ checked: Number(count), changed: 1, failed: 1 });
      expect(await customerOf(upgraded.orgId)).toEqual({ status: 'active', camera_limit: 7 });
      expect(await customerOf(failing.orgId)).toEqual({ status: 'active', camera_limit: 3 });
      expect(await customerOf(unchanged.orgId)).toEqual({ status: 'active', camera_limit: 3 });
    });
  });

  describe('orgs created by the Super Admin', () => {
    it('are unaffected: no limit, events and reconcile never touch them', async () => {
      const directOrg = await createOrgAndLogin(app, superAdminToken, `mp-direct-${Date.now()}`);

      await postEvent(app, marketplaceEvent(ENDED, { awsAccountId: placeholderAwsAccountId() }));
      await postReconcile(app);

      expect((await listCameras(directOrg.orgAdminAccessToken)).statusCode).toBe(200);
      for (const name of ['Direct 1', 'Direct 2', 'Direct 3']) {
        expect((await createCamera(directOrg.orgAdminAccessToken, name)).statusCode).toBe(201);
      }
      expect((await getSubscription(directOrg.orgAdminAccessToken)).json()).toEqual({
        source: 'direct',
        status: 'active',
        cameraLimit: null,
        expiresAt: null,
      });
      expect((await refresh(directOrg.orgAdminRefreshToken)).statusCode).toBe(200);
    });

    it('are blocked on the next request and on refresh once deactivated', async () => {
      const directOrg = await createOrgAndLogin(app, superAdminToken, `mp-deact-${Date.now()}`);
      expect((await listCameras(directOrg.orgAdminAccessToken)).statusCode).toBe(200);

      const deactivate = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/organizations/${directOrg.orgId}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { is_active: false },
      });
      expect(deactivate.statusCode).toBe(200);

      const next = await listCameras(directOrg.orgAdminAccessToken);
      expect(next.statusCode).toBe(403);
      expect(next.json()).toEqual({
        error: { code: 'FORBIDDEN', message: 'Organization is deactivated' },
      });
      expect((await refresh(directOrg.orgAdminRefreshToken)).statusCode).toBe(403);
    });
  });

  describe('cross-org isolation', () => {
    it("an event for org A's AWS account never changes org B", async () => {
      const orgA = await activeOrg('cross-a', 5);
      const orgB = await activeOrg('cross-b', 5);
      expect((await listCameras(orgB.accessToken)).statusCode).toBe(200);
      entitlementMock.resetHistory();
      aws.remove(orgA.awsAccountId);

      await postEvent(
        app,
        marketplaceEvent(LICENSE_DEPROVISIONED, { awsAccountId: orgA.awsAccountId }),
      );

      expect(aws.queriedAccounts()).toEqual([orgA.awsAccountId]);
      expect((await customerOf(orgA.orgId)).status).toBe('cancelled');
      expect(await customerOf(orgB.orgId)).toEqual({ status: 'active', camera_limit: 5 });
      expect((await listCameras(orgA.accessToken)).statusCode).toBe(403);
      expect((await listCameras(orgB.accessToken)).statusCode).toBe(200);
      expect((await getSubscription(orgB.accessToken)).json()).toMatchObject({
        status: 'active',
        cameraLimit: 5,
      });
    });
  });
});
