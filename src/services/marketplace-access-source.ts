import {
  AgreementStatus,
  DescribeAgreementCommand,
  type MarketplaceAgreementClient,
} from '@aws-sdk/client-marketplace-agreement';
import type { MarketplaceEntitlementServiceClient } from '@aws-sdk/client-marketplace-entitlement-service';
import {
  fetchEntitlements,
  pickCameraEntitlement,
  type CameraEntitlement,
  type MarketplaceCustomer,
} from '@services/entitlement.service';
import type { MarketplacePricingModel } from '@config/env';

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
 * Free listings: AWS has no entitlements for these, so the buyer has access while
 * their agreement is ACTIVE, with a fixed allowance. Any other status (cancelled,
 * expired, terminated, replaced by a newer agreement…) means no access.
 */
export function freeAccessSource(
  client: MarketplaceAgreementClient,
  freeCameraLimit: number,
): MarketplaceAccessSource {
  return {
    async readCameraAllowance(customer) {
      // Without an agreement there is nothing to ask AWS about. Fail loudly so the
      // event is retried and reconcile reports it, instead of silently cutting access.
      if (!customer.agreement_id) {
        throw new Error(`Marketplace customer ${customer.id} has no agreement ID`);
      }
      const agreement = await client.send(
        new DescribeAgreementCommand({ agreementId: customer.agreement_id }),
      );
      if (agreement.status !== AgreementStatus.ACTIVE) return null;
      return { cameraLimit: freeCameraLimit, expiresAt: null };
    },
  };
}

export interface MarketplaceAccessSourceOptions {
  pricingModel: MarketplacePricingModel;
  entitlementClient: MarketplaceEntitlementServiceClient;
  agreementClient: MarketplaceAgreementClient;
  cameraDimension: string;
  freeCameraLimit: number;
}

export function createMarketplaceAccessSource(
  options: MarketplaceAccessSourceOptions,
): MarketplaceAccessSource {
  if (options.pricingModel === 'free') {
    return freeAccessSource(options.agreementClient, options.freeCameraLimit);
  }
  return contractAccessSource(options.entitlementClient, options.cameraDimension);
}
