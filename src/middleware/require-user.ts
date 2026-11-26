import type { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '@utils/errors';
import { rejectIfOrgAccessDenied } from '@middleware/org-access';

/** Verifies an org user's access token; sends 401/403 and returns false if it is not one. */
async function verifyOrgUserToken(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  try {
    await request.jwtVerify();
  } catch {
    const err = AppError.unauthorized('Missing or invalid access token');
    await reply.code(401).send({ error: { code: err.code, message: err.message } });
    return false;
  }

  if (request.user.type !== 'access') {
    const err = AppError.unauthorized('Invalid token type');
    await reply.code(401).send({ error: { code: err.code, message: err.message } });
    return false;
  }

  if (request.user.role !== 'org_admin' && request.user.role !== 'viewer') {
    const err = AppError.forbidden('Org user access required');
    await reply.code(403).send({ error: { code: err.code, message: err.message } });
    return false;
  }

  if (!request.user.org_id) {
    const err = AppError.forbidden('Org user access required');
    await reply.code(403).send({ error: { code: err.code, message: err.message } });
    return false;
  }

  return true;
}

/** Any org user whose org currently has access. */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!(await verifyOrgUserToken(request, reply))) return;
  await rejectIfOrgAccessDenied(request, reply);
}

/**
 * Any org user, even when their org's subscription is pending or cancelled.
 * Only for routes that explain that state, such as GET /org/subscription.
 */
export async function requireUserAnySubscription(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await verifyOrgUserToken(request, reply);
}
