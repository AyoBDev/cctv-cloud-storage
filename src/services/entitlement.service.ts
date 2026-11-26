import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import {
  GetEntitlementsCommand,
  type Entitlement,
  type MarketplaceEntitlementServiceClient,
} from '@aws-sdk/client-marketplace-entitlement-service';
import { AppError, ErrorCodes } from '@utils/errors';

/**
 * How long an org's access decision is cached. Every entitlement sync clears the
 * key, so this only bounds how long other changes (e.g. a Super Admin deactivating
 * an org) take to reach requests that already hold a valid access token.
 */
const ORG_ACCESS_CACHE_TTL_SECONDS = 60;

export type MarketplaceCustomerStatus = 'pending_activation' | 'active' | 'cancelled';

export interface CameraEntitlement {
  cameraLimit: number;
  expiresAt: Date | null;
}

export interface MarketplaceCustomer {
  id: string;
  org_id: string;
  aws_account_id: string;
  product_code: string;
  status: MarketplaceCustomerStatus;
  camera_limit: number;
  entitlement_expires_at: Date | null;
}

/** Reads every entitlement AWS holds for one buyer account (handles pagination). */
export async function fetchEntitlements(
  client: MarketplaceEntitlementServiceClient,
  productCode: string,
  awsAccountId: string,
): Promise<Entitlement[]> {
  const entitlements: Entitlement[] = [];
  let nextToken: string | undefined;

  do {
    const page = await client.send(
      new GetEntitlementsCommand({
        ProductCode: productCode,
        Filter: { CUSTOMER_AWS_ACCOUNT_ID: [awsAccountId] },
        NextToken: nextToken,
      }),
    );
    entitlements.push(...(page.Entitlements ?? []));
    nextToken = page.NextToken;
  } while (nextToken);

  return entitlements;
}

/**
 * Picks the camera allowance from a buyer's entitlements. Only unexpired entitlements
 * for the camera dimension count. If several are valid (e.g. during a renewal overlap)
 * the largest allowance wins, so a renewal never briefly lowers the limit.
 */
export function pickCameraEntitlement(
  entitlements: Entitlement[],
  cameraDimension: string,
  now: Date,
): CameraEntitlement | null {
  let best: CameraEntitlement | null = null;

  for (const entitlement of entitlements) {
    if (entitlement.Dimension !== cameraDimension) continue;

    const cameraLimit = entitlement.Value?.IntegerValue;
    if (cameraLimit === undefined || cameraLimit <= 0) continue;

    const expiresAt = entitlement.ExpirationDate ?? null;
    if (expiresAt && expiresAt.getTime() <= now.getTime()) continue;

    if (!best || cameraLimit > best.cameraLimit) {
      best = { cameraLimit, expiresAt };
    }
  }

  return best;
}

/**
 * Decides the customer's status from what AWS currently says.
 * A customer who was never activated stays pending (AWS may not have sent
 * `License Updated` yet); one who had access and lost it is cancelled.
 */
export function nextCustomerStatus(
  current: MarketplaceCustomerStatus,
  entitlement: CameraEntitlement | null,
): MarketplaceCustomerStatus {
  if (entitlement) return 'active';
  return current === 'pending_activation' ? 'pending_activation' : 'cancelled';
}

/**
 * The single place where a Marketplace customer's access is decided. Events,
 * signup/link and scheduled checks all call this, so state never depends on the
 * order or number of events AWS delivers.
 */
export async function syncCustomerEntitlement(
  db: Sql,
  redis: Redis,
  client: MarketplaceEntitlementServiceClient,
  customerId: string,
  cameraDimension: string,
): Promise<MarketplaceCustomer> {
  const rows = await db<MarketplaceCustomer[]>`
    SELECT id, org_id, aws_account_id, product_code, status, camera_limit, entitlement_expires_at
    FROM marketplace_customers WHERE id = ${customerId}
  `;
  const customer = rows[0];
  if (!customer) throw new Error(`Marketplace customer ${customerId} not found`);

  const entitlements = await fetchEntitlements(
    client,
    customer.product_code,
    customer.aws_account_id,
  );
  const entitlement = pickCameraEntitlement(entitlements, cameraDimension, new Date());
  const status = nextCustomerStatus(customer.status, entitlement);

  const updated = await db<MarketplaceCustomer[]>`
    UPDATE marketplace_customers
    SET status = ${status},
        camera_limit = ${entitlement?.cameraLimit ?? 0},
        entitlement_expires_at = ${entitlement?.expiresAt ?? null},
        last_synced_at = now(),
        updated_at = now()
    WHERE id = ${customerId}
    RETURNING id, org_id, aws_account_id, product_code, status, camera_limit, entitlement_expires_at
  `;

  const synced = updated[0] as MarketplaceCustomer;
  // The very next request from this org must see the new status, not a cached one.
  await invalidateOrgAccess(redis, synced.org_id);
  return synced;
}

function hasEntitlementChanged(before: MarketplaceCustomer, after: MarketplaceCustomer): boolean {
  return (
    before.status !== after.status ||
    before.camera_limit !== after.camera_limit ||
    before.entitlement_expires_at?.getTime() !== after.entitlement_expires_at?.getTime()
  );
}

export interface ReconcileResult {
  checked: number;
  changed: number;
  failed: number;
}

/**
 * Re-syncs every Marketplace customer with AWS. Catches anything a lost or
 * delayed event missed (and entitlements that simply expire). One customer
 * failing must not stop the rest of the run.
 */
export async function reconcileAllCustomers(
  db: Sql,
  redis: Redis,
  client: MarketplaceEntitlementServiceClient,
  cameraDimension: string,
  log: FastifyBaseLogger,
): Promise<ReconcileResult> {
  const customers = await db<MarketplaceCustomer[]>`
    SELECT id, org_id, aws_account_id, product_code, status, camera_limit, entitlement_expires_at
    FROM marketplace_customers
    ORDER BY created_at
  `;
  const result: ReconcileResult = { checked: 0, changed: 0, failed: 0 };

  for (const before of customers) {
    result.checked += 1;
    try {
      const after = await syncCustomerEntitlement(db, redis, client, before.id, cameraDimension);
      if (hasEntitlementChanged(before, after)) {
        result.changed += 1;
        log.info(
          {
            customerId: after.id,
            orgId: after.org_id,
            status: { from: before.status, to: after.status },
            cameraLimit: { from: before.camera_limit, to: after.camera_limit },
          },
          'Marketplace customer entitlement changed during reconcile',
        );
      }
    } catch (err) {
      result.failed += 1;
      log.error({ err, customerId: before.id }, 'Marketplace reconcile failed for customer');
    }
  }

  return result;
}

// ── Per-request org access ─────────────────────────────────────────────────

export type SubscriptionSource = 'aws_marketplace' | 'direct';

/** `deactivated` is the Super Admin switch (organizations.is_active = false). */
export type OrgAccessStatus = 'active' | 'deactivated' | MarketplaceCustomerStatus;

export interface OrgAccess {
  source: SubscriptionSource;
  status: OrgAccessStatus;
  /** Most cameras the org may have active at once; null means no limit. */
  cameraLimit: number | null;
  expiresAt: string | null;
}

interface OrgAccessRow {
  org_is_active: boolean;
  marketplace_status: MarketplaceCustomerStatus | null;
  camera_limit: number | null;
  entitlement_expires_at: Date | null;
}

export function orgAccessCacheKey(orgId: string): string {
  return `org-access:${orgId}`;
}

export async function invalidateOrgAccess(redis: Redis, orgId: string): Promise<void> {
  await redis.del(orgAccessCacheKey(orgId));
}

const MISSING_ORG_ACCESS: OrgAccess = {
  source: 'direct',
  status: 'deactivated',
  cameraLimit: 0,
  expiresAt: null,
};

/**
 * Orgs with no marketplace_customers row (created by the Super Admin) keep
 * today's rule: allowed while active, no camera limit.
 */
function toOrgAccess(row: OrgAccessRow): OrgAccess {
  if (row.marketplace_status === null) {
    return {
      source: 'direct',
      status: row.org_is_active ? 'active' : 'deactivated',
      cameraLimit: null,
      expiresAt: null,
    };
  }
  return {
    source: 'aws_marketplace',
    status: row.org_is_active ? row.marketplace_status : 'deactivated',
    cameraLimit: row.camera_limit,
    expiresAt: row.entitlement_expires_at?.toISOString() ?? null,
  };
}

async function loadOrgAccess(db: Sql, orgId: string): Promise<OrgAccess> {
  const rows = await db<OrgAccessRow[]>`
    SELECT o.is_active AS org_is_active,
           mc.status AS marketplace_status,
           mc.camera_limit,
           mc.entitlement_expires_at
    FROM organizations o
    LEFT JOIN marketplace_customers mc ON mc.org_id = o.id
    WHERE o.id = ${orgId}
  `;
  const row = rows[0];
  return row ? toOrgAccess(row) : MISSING_ORG_ACCESS;
}

/** The org's current access, read on every org-user request (cached briefly in Redis). */
export async function getOrgAccess(db: Sql, redis: Redis, orgId: string): Promise<OrgAccess> {
  const key = orgAccessCacheKey(orgId);
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached) as OrgAccess;

  const access = await loadOrgAccess(db, orgId);
  await redis.setex(key, ORG_ACCESS_CACHE_TTL_SECONDS, JSON.stringify(access));
  return access;
}

/** Why an org's users may not use the API right now, or null when they may. */
export function orgAccessDenial(access: OrgAccess): AppError | null {
  switch (access.status) {
    case 'active':
      return null;
    case 'deactivated':
      return AppError.forbidden('Organization is deactivated');
    case 'pending_activation':
      return new AppError(
        ErrorCodes.SUBSCRIPTION_PENDING,
        'Your AWS Marketplace subscription is waiting to be activated by AWS',
        403,
      );
    case 'cancelled':
      return new AppError(
        ErrorCodes.SUBSCRIPTION_INACTIVE,
        'Your AWS Marketplace subscription is no longer active',
        403,
      );
  }
}

/**
 * Sign-in (login and token refresh) is more lenient than per-request access:
 * pending orgs may still sign in so the website can show a "waiting for AWS" state.
 */
export function signInDenial(access: OrgAccess): AppError | null {
  if (access.status === 'pending_activation') return null;
  return orgAccessDenial(access);
}
