import {
  AgreementStatus,
  DescribeAgreementCommand,
  type MarketplaceAgreementClient,
} from '@aws-sdk/client-marketplace-agreement';
import type { MarketplaceEntitlementServiceClient } from '@aws-sdk/client-marketplace-entitlement-service';
import type { Sql } from 'postgres';
import {
  fetchEntitlements,
  pickCameraEntitlement,
  type CameraEntitlement,
  type MarketplaceCustomer,
} from '@services/entitlement.service';
import { AGREEMENT_ENDED_DETAIL_TYPES } from '@services/marketplace-event.service';
import type { MarketplaceFreeAccessCheck, MarketplacePricingModel } from '@config/env';

/** Reads what AWS currently says one Marketplace customer may use. */
export interface MarketplaceAccessSource {
  /** The customer's camera allowance, or null when AWS says they have no access. */
  readCameraAllowance(customer: MarketplaceCustomer, now: Date): Promise<CameraEntitlement | null>;
}

/** Contract listings: the allowance is the buyer's unexpired camera entitlement. */
export function contractAccessSource(
  client: MarketplaceEntitlementServiceClient,
  cameraDimension: string,
): MarketplaceAccessSource {
  return {
    async readCameraAllowance(customer, now) {
      const entitlements = await fetchEntitlements(
        client,
        customer.product_code,
        customer.aws_account_id,
      );
      return pickCameraEntitlement(entitlements, cameraDimension, now);
    },
  };
}

/**
 * Free listings check access by agreement. Without one there is nothing to check,
 * so fail loudly (the event is retried and reconcile reports it) rather than
 * silently granting or cutting access.
 */
function requireAgreementId(customer: MarketplaceCustomer): string {
  if (!customer.agreement_id) {
    throw new Error(`Marketplace customer ${customer.id} has no agreement ID`);
  }
  return customer.agreement_id;
}

/**
 * Free listings, checked with AWS: AWS has no entitlements for these, so the buyer
 * has access while their agreement is ACTIVE, with a fixed allowance. Any other
 * status (cancelled, expired, terminated, replaced by a newer agreement…) means no
 * access. Needs `aws-marketplace:DescribeAgreement` on the seller role.
 */
export function freeAccessFromAgreementStatus(
  client: MarketplaceAgreementClient,
  freeCameraLimit: number,
): MarketplaceAccessSource {
  return {
    async readCameraAllowance(customer) {
      const agreement = await client.send(
        new DescribeAgreementCommand({ agreementId: requireAgreementId(customer) }),
      );
      if (agreement.status !== AgreementStatus.ACTIVE) return null;
      return { cameraLimit: freeCameraLimit, expiresAt: null };
    },
  };
}

/**
 * Free listings, checked from the events AWS has sent us: the buyer has access
 * until a `Purchase Agreement Ended` event arrives for their current agreement.
 *
 * Signup itself proves the subscription (AWS only issues a registration token to
 * a buyer who just subscribed). Only the current agreement counts, and `Created`
 * events move the customer to the newest one, so a late `Ended` for an old
 * agreement does not cut off a buyer who subscribed again.
 *
 * Trade-off: nothing re-checks with AWS, so a lost `Ended` event leaves access on.
 */
export function freeAccessFromEvents(db: Sql, freeCameraLimit: number): MarketplaceAccessSource {
  return {
    async readCameraAllowance(customer) {
      const endedEvents = await db`
        SELECT 1 FROM marketplace_events
        WHERE agreement_id = ${requireAgreementId(customer)}
          AND detail_type IN ${db([...AGREEMENT_ENDED_DETAIL_TYPES])}
        LIMIT 1
      `;
      if (endedEvents.length > 0) return null;
      return { cameraLimit: freeCameraLimit, expiresAt: null };
    },
  };
}

export interface MarketplaceAccessSourceOptions {
  pricingModel: MarketplacePricingModel;
  freeAccessCheck: MarketplaceFreeAccessCheck;
  db: Sql;
  entitlementClient: MarketplaceEntitlementServiceClient;
  agreementClient: MarketplaceAgreementClient;
  cameraDimension: string;
  freeCameraLimit: number;
}

export function createMarketplaceAccessSource(
  options: MarketplaceAccessSourceOptions,
): MarketplaceAccessSource {
  if (options.pricingModel === 'free' && options.freeAccessCheck === 'agreement') {
    return freeAccessFromAgreementStatus(options.agreementClient, options.freeCameraLimit);
  }
  if (options.pricingModel === 'free') {
    return freeAccessFromEvents(options.db, options.freeCameraLimit);
  }
  return contractAccessSource(options.entitlementClient, options.cameraDimension);
}
