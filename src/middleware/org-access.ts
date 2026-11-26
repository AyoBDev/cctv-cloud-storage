import type { FastifyRequest, FastifyReply } from 'fastify';
import { getOrgAccess, orgAccessDenial } from '@services/entitlement.service';

/**
 * Blocks org users whose org may not use the API right now (deactivated by the
 * Super Admin, or an AWS Marketplace subscription that is pending or cancelled).
 * Checked on every request, not only at login, so a cancellation takes effect on
 * the very next request instead of when the 15-minute access token expires.
 *
 * Call only after the access token is verified and `org_id` is known to be set.
 */
export async function rejectIfOrgAccessDenied(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const orgId = request.user.org_id as string;
  const access = await getOrgAccess(request.server.db, request.server.redis, orgId);
  const denial = orgAccessDenial(access);
  if (denial) {
    await reply
      .code(denial.statusCode)
      .send({ error: { code: denial.code, message: denial.message } });
  }
}
