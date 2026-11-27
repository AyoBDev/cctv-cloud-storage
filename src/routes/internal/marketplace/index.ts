import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalSecret } from '@middleware/require-internal-secret';
import { reconcileAllCustomers } from '@services/entitlement.service';
import { handleMarketplaceEvent, type MarketplaceEvent } from '@services/marketplace-event.service';

const MARKETPLACE_EVENT_SOURCE = 'aws.agreement-marketplace';

/**
 * A raw EventBridge event, as forwarded by the queue Lambda. Only the fields we
 * read are validated; the whole event is stored as-is. The license ARN is kept
 * as an opaque string: AWS's own examples are not always well-formed ARNs.
 */
const eventBridgeEventSchema = z
  .object({
    id: z.string().min(1).max(255),
    'detail-type': z.string().min(1).max(255),
    source: z.literal(MARKETPLACE_EVENT_SOURCE),
    detail: z
      .object({
        agreement: z
          .object({ id: z.string().min(1).optional() })
          .passthrough()
          .optional(),
        license: z
          .object({ arn: z.string().min(1).optional() })
          .passthrough()
          .optional(),
        acceptor: z
          .object({ accountId: z.string().min(1).optional() })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

type EventBridgeEvent = z.infer<typeof eventBridgeEventSchema>;

function toMarketplaceEvent(event: EventBridgeEvent): MarketplaceEvent {
  return {
    eventId: event.id,
    detailType: event['detail-type'],
    agreementId: event.detail.agreement?.id ?? null,
    licenseArn: event.detail.license?.arn ?? null,
    awsAccountId: event.detail.acceptor?.accountId ?? null,
    payload: event,
  };
}

export default async function internalMarketplaceRoutes(app: FastifyInstance): Promise<void> {
  // POST /internal/marketplace/events — one AWS Marketplace EventBridge event.
  app.post(
    '/events',
    {
      preHandler: [requireInternalSecret],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              outcome: {
                type: 'string',
                enum: ['synced', 'ignored', 'no_customer', 'already_processed'],
              },
            },
          },
        },
      },
    },
    async (request) => {
      const event = toMarketplaceEvent(eventBridgeEventSchema.parse(request.body));
      const outcome = await handleMarketplaceEvent(
        app.db,
        app.redis,
        app.marketplaceAccess,
        event,
        request.log,
      );
      return { outcome };
    },
  );

  // POST /internal/marketplace/reconcile — re-sync every customer (run on a schedule).
  app.post(
    '/reconcile',
    {
      preHandler: [requireInternalSecret],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              checked: { type: 'integer' },
              changed: { type: 'integer' },
              failed: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request) => reconcileAllCustomers(app.db, app.redis, app.marketplaceAccess, request.log),
  );
}
