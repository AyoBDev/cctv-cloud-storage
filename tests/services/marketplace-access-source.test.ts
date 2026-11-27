import { mockClient } from 'aws-sdk-client-mock';
import {
  DescribeAgreementCommand,
  MarketplaceAgreementClient,
} from '@aws-sdk/client-marketplace-agreement';
import {
  GetEntitlementsCommand,
  MarketplaceEntitlementServiceClient,
} from '@aws-sdk/client-marketplace-entitlement-service';
import type { Sql } from 'postgres';
import type { MarketplaceCustomer } from '../../src/services/entitlement.service';
import {
  contractAccessSource,
  createMarketplaceAccessSource,
  freeAccessFromAgreementStatus,
} from '../../src/services/marketplace-access-source';

const agreementMock = mockClient(MarketplaceAgreementClient);
const entitlementMock = mockClient(MarketplaceEntitlementServiceClient);

const FREE_CAMERA_LIMIT = 5;
const CAMERA_DIMENSION = 'cameras';
const NOW = new Date('2026-06-01T00:00:00Z');
const NEXT_YEAR = new Date('2027-06-01T00:00:00Z');

/** Placeholder identifiers only. */
function customer(overrides: Partial<MarketplaceCustomer> = {}): MarketplaceCustomer {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    org_id: '00000000-0000-0000-0000-000000000002',
    aws_account_id: '111122223333',
    product_code: 'exampleproductcode',
    agreement_id: 'agmt-example0000000000000',
    status: 'pending_activation',
    camera_limit: 0,
    entitlement_expires_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  agreementMock.reset();
  entitlementMock.reset();
});

describe('freeAccessFromAgreementStatus', () => {
  const source = () =>
    freeAccessFromAgreementStatus(new MarketplaceAgreementClient({}), FREE_CAMERA_LIMIT);

  it('gives the free camera limit, with no end date, while the agreement is ACTIVE', async () => {
    agreementMock.on(DescribeAgreementCommand).resolves({ status: 'ACTIVE' });

    await expect(source().readCameraAllowance(customer(), NOW)).resolves.toEqual({
      cameraLimit: FREE_CAMERA_LIMIT,
      expiresAt: null,
    });
    expect(agreementMock.commandCalls(DescribeAgreementCommand)[0]?.args[0].input).toEqual({
      agreementId: 'agmt-example0000000000000',
    });
  });

  it.each(['CANCELLED', 'EXPIRED', 'TERMINATED', 'REPLACED', 'RENEWED', 'SUPERSEDED'] as const)(
    'gives no access when the agreement is %s',
    async (status) => {
      agreementMock.on(DescribeAgreementCommand).resolves({ status });

      await expect(source().readCameraAllowance(customer(), NOW)).resolves.toBeNull();
    },
  );

  it('fails, rather than cutting access, when the customer has no agreement ID', async () => {
    await expect(
      source().readCameraAllowance(customer({ agreement_id: null }), NOW),
    ).rejects.toThrow('has no agreement ID');
    expect(agreementMock.commandCalls(DescribeAgreementCommand)).toHaveLength(0);
  });

  it('passes AWS errors on so the caller can retry', async () => {
    agreementMock.on(DescribeAgreementCommand).rejects(new Error('Simulated AWS outage'));

    await expect(source().readCameraAllowance(customer(), NOW)).rejects.toThrow(
      'Simulated AWS outage',
    );
  });
});

describe('contractAccessSource', () => {
  it('reads the camera entitlement for the customer account and product', async () => {
    entitlementMock.on(GetEntitlementsCommand).resolves({
      Entitlements: [
        { Dimension: CAMERA_DIMENSION, Value: { IntegerValue: 12 }, ExpirationDate: NEXT_YEAR },
      ],
    });
    const source = contractAccessSource(
      new MarketplaceEntitlementServiceClient({}),
      CAMERA_DIMENSION,
    );

    await expect(source.readCameraAllowance(customer(), NOW)).resolves.toEqual({
      cameraLimit: 12,
      expiresAt: NEXT_YEAR,
    });
    expect(entitlementMock.commandCalls(GetEntitlementsCommand)[0]?.args[0].input).toMatchObject({
      ProductCode: 'exampleproductcode',
      Filter: { CUSTOMER_AWS_ACCOUNT_ID: ['111122223333'] },
    });
  });
});

describe('createMarketplaceAccessSource', () => {
  /** Stands in for the database: every query finds no rows (no `Ended` events). */
  const queries: unknown[] = [];
  const noRowsDb = ((...args: unknown[]) => {
    queries.push(args);
    return Promise.resolve([]);
  }) as unknown as Sql;

  const options = (pricingModel: 'contract' | 'free', freeAccessCheck: 'events' | 'agreement') => ({
    pricingModel,
    freeAccessCheck,
    db: noRowsDb,
    entitlementClient: new MarketplaceEntitlementServiceClient({}),
    agreementClient: new MarketplaceAgreementClient({}),
    cameraDimension: CAMERA_DIMENSION,
    freeCameraLimit: FREE_CAMERA_LIMIT,
  });

  beforeEach(() => {
    queries.length = 0;
  });

  it('uses stored events, and no AWS call, for free listings in events mode', async () => {
    const allowance = await createMarketplaceAccessSource(
      options('free', 'events'),
    ).readCameraAllowance(customer(), NOW);

    expect(allowance).toEqual({ cameraLimit: FREE_CAMERA_LIMIT, expiresAt: null });
    expect(queries.length).toBeGreaterThan(0);
    expect(agreementMock.commandCalls(DescribeAgreementCommand)).toHaveLength(0);
    expect(entitlementMock.commandCalls(GetEntitlementsCommand)).toHaveLength(0);
  });

  it('uses the agreement status for free listings in agreement mode', async () => {
    agreementMock.on(DescribeAgreementCommand).resolves({ status: 'ACTIVE' });

    const allowance = await createMarketplaceAccessSource(
      options('free', 'agreement'),
    ).readCameraAllowance(customer(), NOW);

    expect(allowance?.cameraLimit).toBe(FREE_CAMERA_LIMIT);
    expect(entitlementMock.commandCalls(GetEntitlementsCommand)).toHaveLength(0);
  });

  it('uses entitlements for contract listings, whatever the free check is', async () => {
    entitlementMock.on(GetEntitlementsCommand).resolves({ Entitlements: [] });

    const allowance = await createMarketplaceAccessSource(
      options('contract', 'events'),
    ).readCameraAllowance(customer(), NOW);

    expect(allowance).toBeNull();
    expect(queries).toHaveLength(0);
    expect(agreementMock.commandCalls(DescribeAgreementCommand)).toHaveLength(0);
  });
});
