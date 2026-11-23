import type { FastifyInstance, FastifyReply } from 'fastify';
import formbody from '@fastify/formbody';
import { z } from 'zod';
import { env } from '@config/env';
import { requireOrgAdmin } from '@middleware/require-org-admin';
import {
  REFERENCE_PATTERN,
  RegistrationTokenError,
  createPendingRegistration,
  findUsableRegistration,
  resolveRegistrationToken,
} from '@services/marketplace-registration.service';
import {
  isAwsAccountLinked,
  linkRegistrationToOrg,
  signUpFromRegistration,
  type LinkedMarketplaceCustomer,
} from '@services/marketplace-account.service';
import { syncCustomerEntitlement } from '@services/entitlement.service';

/** Form fields AWS Marketplace posts to the fulfillment URL. */
const TOKEN_FIELD = 'x-amzn-marketplace-token';
const OFFER_TYPE_FIELD = 'x-amzn-marketplace-offer-type';
const FREE_TRIAL_OFFER_TYPE = 'free-trial';

const registerBodySchema = z.object({
  [TOKEN_FIELD]: z.string().min(1),
  [OFFER_TYPE_FIELD]: z.string().optional(),
});

const referenceParamsSchema = z.object({
  reference: z.string().regex(REFERENCE_PATTERN, 'Invalid registration reference'),
});

const signupBodySchema = z.object({
  organizationName: z.string().trim().min(1).max(255),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8),
});

const referenceParamsJsonSchema = {
  type: 'object',
  required: ['reference'],
  properties: { reference: { type: 'string' } },
} as const;

const linkResultJsonSchema = {
  type: 'object',
  properties: {
    organizationId: { type: 'string' },
    subscriptionStatus: { type: 'string', enum: ['pending_activation', 'active', 'cancelled'] },
  },
} as const;

function websiteUrl(query: Record<string, string>): string {
  const url = new URL(env.MARKETPLACE_REGISTRATION_PAGE_URL);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

/** 303 turns AWS's form POST into a GET of the website page. */
function redirectToWebsite(reply: FastifyReply, query: Record<string, string>): FastifyReply {
  return reply.redirect(websiteUrl(query), 303);
}

export default async function marketplaceRoutes(app: FastifyInstance): Promise<void> {
  // AWS posts application/x-www-form-urlencoded; only this route scope needs it.
  await app.register(formbody);

  /**
   * Checks the buyer with AWS right away and reports whether they now have access.
   * The org is already saved at this point, so an AWS outage must not fail the
   * request: the customer stays pending and the next event or scheduled sync fixes it.
   */
  async function activateLinkedCustomer(linked: LinkedMarketplaceCustomer) {
    try {
      const customer = await syncCustomerEntitlement(
        app.db,
        app.marketplaceEntitlement,
        linked.customerId,
        env.MARKETPLACE_CAMERA_DIMENSION,
      );
      return { organizationId: linked.organizationId, subscriptionStatus: customer.status };
    } catch (err) {
      app.log.error({ err, customerId: linked.customerId }, 'Marketplace entitlement sync failed');
      return { organizationId: linked.organizationId, subscriptionStatus: 'pending_activation' };
    }
  }

  // POST /api/v1/marketplace/register — the fulfillment URL set in the AWS listing.
  app.post('/register', async (request, reply) => {
    const parsed = registerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return redirectToWebsite(reply, { error: 'token_invalid' });
    }

    try {
      const customer = await resolveRegistrationToken(
        app.marketplaceMetering,
        parsed.data[TOKEN_FIELD],
        env.MARKETPLACE_PRODUCT_CODE,
      );
      const reference = await createPendingRegistration(app.db, customer, {
        isFreeTrial: parsed.data[OFFER_TYPE_FIELD] === FREE_TRIAL_OFFER_TYPE,
        ttlMinutes: env.MARKETPLACE_REGISTRATION_TTL_MINUTES,
      });
      return redirectToWebsite(reply, { ref: reference });
    } catch (err) {
      if (err instanceof RegistrationTokenError) {
        request.log.warn({ problem: err.problem }, 'Marketplace registration token rejected');
        return redirectToWebsite(reply, { error: err.problem });
      }
      request.log.error({ err }, 'Marketplace registration failed');
      return redirectToWebsite(reply, { error: 'unavailable' });
    }
  });

  // GET /api/v1/marketplace/registrations/:reference — what the website shows first.
  app.get(
    '/registrations/:reference',
    {
      schema: {
        params: referenceParamsJsonSchema,
        response: {
          200: {
            type: 'object',
            properties: {
              isFreeTrial: { type: 'boolean' },
              expiresAt: { type: 'string', format: 'date-time' },
              awsAccountAlreadyLinked: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request) => {
      const { reference } = referenceParamsSchema.parse(request.params);
      const registration = await findUsableRegistration(app.db, reference);
      return {
        isFreeTrial: registration.is_free_trial,
        expiresAt: registration.expires_at.toISOString(),
        awsAccountAlreadyLinked: await isAwsAccountLinked(app.db, registration.aws_account_id),
      };
    },
  );

  // POST /api/v1/marketplace/registrations/:reference/signup — new customer.
  app.post(
    '/registrations/:reference/signup',
    {
      schema: {
        params: referenceParamsJsonSchema,
        body: {
          type: 'object',
          required: ['organizationName', 'adminEmail', 'adminPassword'],
          properties: {
            organizationName: { type: 'string', minLength: 1, maxLength: 255 },
            adminEmail: { type: 'string', format: 'email' },
            adminPassword: { type: 'string', minLength: 8 },
          },
        },
        response: { 201: linkResultJsonSchema },
      },
    },
    async (request, reply) => {
      const { reference } = referenceParamsSchema.parse(request.params);
      const body = signupBodySchema.parse(request.body);
      const linked = await signUpFromRegistration(app.db, reference, body);
      return reply.code(201).send(await activateLinkedCustomer(linked));
    },
  );

  // POST /api/v1/marketplace/registrations/:reference/link — signed-in Org Admin.
  app.post(
    '/registrations/:reference/link',
    {
      preHandler: [requireOrgAdmin],
      schema: {
        params: referenceParamsJsonSchema,
        response: { 200: linkResultJsonSchema },
      },
    },
    async (request) => {
      const { reference } = referenceParamsSchema.parse(request.params);
      const orgId = request.user.org_id as string;
      const linked = await linkRegistrationToOrg(app.db, reference, orgId);
      return activateLinkedCustomer(linked);
    },
  );
}
