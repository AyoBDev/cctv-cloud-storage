import type { FastifyInstance } from 'fastify';
import { requireUserAnySubscription } from '@middleware/require-user';
import { getOrgAccess } from '@services/entitlement.service';

export default async function orgSubscriptionRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/org/subscription — allowed even while pending or cancelled, so the
  // website can explain why the rest of the API is refusing requests.
  app.get(
    '/',
    {
      preHandler: [requireUserAnySubscription],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              source: { type: 'string', enum: ['aws_marketplace', 'direct'] },
              status: {
                type: 'string',
                enum: ['active', 'deactivated', 'pending_activation', 'cancelled'],
              },
              cameraLimit: { type: ['integer', 'null'] },
              expiresAt: { type: ['string', 'null'], format: 'date-time' },
            },
          },
        },
      },
    },
    async (request) => getOrgAccess(app.db, app.redis, request.user.org_id as string),
  );
}
