import type { Sql } from 'postgres';
import {
  GetEntitlementsCommand,
  type Entitlement,
  type MarketplaceEntitlementServiceClient,
} from '@aws-sdk/client-marketplace-entitlement-service';

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

  return updated[0] as MarketplaceCustomer;
}
