import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { AppError, ErrorCodes } from '@utils/errors';
import { syncCustomerEntitlement } from '@services/entitlement.service';
import type { MarketplaceAccessSource } from '@services/marketplace-access-source';

/**
 * Agreement and license events that can change what a buyer is entitled to.
 * AWS sends the `- Manufacturer` variant to the product owner and the
 * `- Proposer` variant to the seller of the offer; when we are both, only the
 * Proposer variant arrives, so we act on either.
 */
const ENTITLEMENT_EVENT_NAMES = [
  'Purchase Agreement Created',
  'Purchase Agreement Amended',
  'Purchase Agreement Ended',
  'License Updated',
  'License Deprovisioned',
  'Purchase Agreement Free Trial Converted',
] as const;
const AGREEMENT_PARTIES = ['Manufacturer', 'Proposer'] as const;

/** Starts a new agreement, e.g. a buyer who cancelled and then subscribed again. */
const NEW_AGREEMENT_EVENT_NAME = 'Purchase Agreement Created';
/** Sent when an agreement is cancelled, expires or is terminated. */
const AGREEMENT_ENDED_EVENT_NAME = 'Purchase Agreement Ended';

/** Every detail type AWS uses for "this agreement has ended". */
export const AGREEMENT_ENDED_DETAIL_TYPES: readonly string[] = AGREEMENT_PARTIES.map(
  (party) => `${AGREEMENT_ENDED_EVENT_NAME} - ${party}`,
);

const ENTITLEMENT_DETAIL_TYPES: ReadonlySet<string> = new Set(
  ENTITLEMENT_EVENT_NAMES.flatMap((name) => AGREEMENT_PARTIES.map((party) => `${name} - ${party}`)),
);

/** The fields we keep from an EventBridge event, plus the raw event itself. */
export interface MarketplaceEvent {
  eventId: string;
  detailType: string;
  agreementId: string | null;
  licenseArn: string | null;
  awsAccountId: string | null;
  payload: unknown;
}

/**
 * - `synced`: the buyer's entitlement was re-read from AWS.
 * - `ignored`: a detail type that cannot change entitlements; stored only.
 * - `no_customer`: no org is linked to the buyer's account yet (the event beat
 *   the signup); stored only, because signup runs its own sync.
 * - `already_processed`: a redelivery of an event we already synced.
 */
export type MarketplaceEventOutcome = 'synced' | 'ignored' | 'no_customer' | 'already_processed';

export function isEntitlementEvent(detailType: string): boolean {
  return ENTITLEMENT_DETAIL_TYPES.has(detailType);
}

export function isNewAgreementEvent(detailType: string): boolean {
  return AGREEMENT_PARTIES.some((party) => detailType === `${NEW_AGREEMENT_EVENT_NAME} - ${party}`);
}

/** Stores the event once; reports whether an earlier delivery was already processed. */
async function storeEvent(
  db: Sql,
  event: MarketplaceEvent,
): Promise<{ alreadyProcessed: boolean }> {
  const inserted = await db`
    INSERT INTO marketplace_events
      (event_id, detail_type, agreement_id, license_arn, aws_account_id, payload)
    VALUES (${event.eventId}, ${event.detailType}, ${event.agreementId}, ${event.licenseArn},
            ${event.awsAccountId}, ${JSON.stringify(event.payload)}::jsonb)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id
  `;
  if (inserted.length > 0) return { alreadyProcessed: false };

  const existing = await db<{ processed_at: Date | null }[]>`
    SELECT processed_at FROM marketplace_events WHERE event_id = ${event.eventId}
  `;
  return { alreadyProcessed: existing[0]?.processed_at != null };
}

async function findCustomerIdByAwsAccount(db: Sql, awsAccountId: string): Promise<string | null> {
  const rows = await db<{ id: string }[]>`
    SELECT id FROM marketplace_customers WHERE aws_account_id = ${awsAccountId}
  `;
  return rows[0]?.id ?? null;
}

/**
 * A buyer who subscribes again gets a new agreement, and free listings check access
 * by agreement, so the customer must follow the newest one. Only `Created` events
 * move it: a late `Ended` event for the old agreement must not move it back.
 */
async function recordNewAgreement(db: Sql, customerId: string, agreementId: string): Promise<void> {
  await db`
    UPDATE marketplace_customers
    SET agreement_id = ${agreementId}, updated_at = now()
    WHERE id = ${customerId}
  `;
}

async function markEventProcessed(db: Sql, eventId: string): Promise<void> {
  await db`
    UPDATE marketplace_events SET processed_at = now(), error = NULL WHERE event_id = ${eventId}
  `;
}

async function markEventFailed(db: Sql, eventId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await db`UPDATE marketplace_events SET error = ${message} WHERE event_id = ${eventId}`;
}

/**
 * Records an EventBridge event and, when it can affect a linked buyer, re-reads
 * that buyer's entitlement from AWS. State is never taken from the event itself,
 * so duplicates and out-of-order delivery cannot leave the customer wrong.
 *
 * A failed sync is recorded on the event and reported as a 503 so the queue retries.
 */
export async function handleMarketplaceEvent(
  db: Sql,
  redis: Redis,
  access: MarketplaceAccessSource,
  event: MarketplaceEvent,
  log: FastifyBaseLogger,
): Promise<MarketplaceEventOutcome> {
  const { alreadyProcessed } = await storeEvent(db, event);
  if (alreadyProcessed) return 'already_processed';
  if (!isEntitlementEvent(event.detailType)) return 'ignored';

  const customerId = event.awsAccountId
    ? await findCustomerIdByAwsAccount(db, event.awsAccountId)
    : null;
  if (!customerId) return 'no_customer';

  if (event.agreementId && isNewAgreementEvent(event.detailType)) {
    await recordNewAgreement(db, customerId, event.agreementId);
  }

  try {
    await syncCustomerEntitlement(db, redis, access, customerId);
  } catch (err) {
    log.error({ err, eventId: event.eventId, customerId }, 'Marketplace event sync failed');
    await markEventFailed(db, event.eventId, err);
    throw new AppError(
      ErrorCodes.MARKETPLACE_SYNC_FAILED,
      'Could not check the entitlement with AWS Marketplace; retry later',
      503,
    );
  }

  await markEventProcessed(db, event.eventId);
  return 'synced';
}
