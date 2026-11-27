import { mockClient } from 'aws-sdk-client-mock';
import { MarketplaceMeteringClient } from '@aws-sdk/client-marketplace-metering';
import { MarketplaceEntitlementServiceClient } from '@aws-sdk/client-marketplace-entitlement-service';
import {
  DescribeAgreementCommand,
  MarketplaceAgreementClient,
} from '@aws-sdk/client-marketplace-agreement';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import {
  FakeEntitlements,
  marketplaceEvent,
  placeholderAgreementId,
  placeholderAwsAccountId,
  postEvent,
  signUpMarketplaceOrg,
} from '../helpers/marketplace';
import { syncCustomerEntitlement } from '../../src/services/entitlement.service';
import { freeAccessSource } from '../../src/services/marketplace-access-source';

const meteringMock = mockClient(MarketplaceMeteringClient);
const entitlementMock = mockClient(MarketplaceEntitlementServiceClient);
const agreementMock = mockClient(MarketplaceAgreementClient);

const FREE_CAMERA_LIMIT = 5;
const CREATED = 'Purchase Agreement Created - Manufacturer';
const ENDED = 'Purchase Agreement Ended - Manufacturer';

interface CustomerRow {
  id: string;
  agreement_id: string | null;
  status: string;
  camera_limit: number;
}

describe('AWS Marketplace free listings', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    meteringMock.reset();
    entitlementMock.reset();
    agreementMock.reset();
    // Free listings have no entitlements in AWS.
    new FakeEntitlements(entitlementMock).install();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  async function customerOf(orgId: string): Promise<CustomerRow> {
    const rows = await app.db<CustomerRow[]>`
      SELECT id, agreement_id, status, camera_limit FROM marketplace_customers WHERE org_id = ${orgId}
    `;
    if (!rows[0]) throw new Error(`No marketplace customer for org ${orgId}`);
    return rows[0];
  }

  function agreementStatus(status: 'ACTIVE' | 'CANCELLED') {
    agreementMock.on(DescribeAgreementCommand).resolves({ status });
  }

  function freeAccess() {
    return freeAccessSource(new MarketplaceAgreementClient({}), FREE_CAMERA_LIMIT);
  }

  it('activates a free buyer with the free camera limit, then cancels them when the agreement ends', async () => {
    const org = await signUpMarketplaceOrg(app, meteringMock, placeholderAwsAccountId(), 'free');
    const signedUp = await customerOf(org.orgId);
    // No entitlements: this is how free buyers looked before free listings were supported.
    expect(signedUp.status).toBe('pending_activation');

    agreementStatus('ACTIVE');
    const active = await syncCustomerEntitlement(app.db, app.redis, freeAccess(), signedUp.id);
    expect(active).toMatchObject({ status: 'active', camera_limit: FREE_CAMERA_LIMIT });
    expect(agreementMock.commandCalls(DescribeAgreementCommand)[0]?.args[0].input).toEqual({
      agreementId: signedUp.agreement_id,
    });

    agreementStatus('CANCELLED');
    const cancelled = await syncCustomerEntitlement(app.db, app.redis, freeAccess(), signedUp.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', camera_limit: 0 });
  });

  it('follows the new agreement when a buyer subscribes again', async () => {
    const awsAccountId = placeholderAwsAccountId();
    const org = await signUpMarketplaceOrg(app, meteringMock, awsAccountId, 'resubscribe');
    const originalAgreementId = (await customerOf(org.orgId)).agreement_id;
    const newAgreementId = placeholderAgreementId();

    const res = await postEvent(
      app,
      marketplaceEvent(CREATED, { awsAccountId, agreementId: newAgreementId }),
    );

    expect(res.statusCode).toBe(200);
    expect(originalAgreementId).not.toBe(newAgreementId);
    expect((await customerOf(org.orgId)).agreement_id).toBe(newAgreementId);
  });

  it('keeps the current agreement when a late event ends an older one', async () => {
    const awsAccountId = placeholderAwsAccountId();
    const org = await signUpMarketplaceOrg(app, meteringMock, awsAccountId, 'late-ended');
    const currentAgreementId = (await customerOf(org.orgId)).agreement_id;

    const res = await postEvent(
      app,
      marketplaceEvent(ENDED, { awsAccountId, agreementId: placeholderAgreementId() }),
    );

    expect(res.statusCode).toBe(200);
    expect((await customerOf(org.orgId)).agreement_id).toBe(currentAgreementId);
  });
});
