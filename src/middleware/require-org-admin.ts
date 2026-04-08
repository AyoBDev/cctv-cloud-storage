import type { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '@utils/errors';

export async function requireOrgAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    const err = AppError.unauthorized('Missing or invalid access token');
    await reply.code(401).send({ error: { code: err.code, message: err.message } });
    return;
  }

  if (request.user.type !== 'access') {
    const err = AppError.unauthorized('Invalid token type');
    await reply.code(401).send({ error: { code: err.code, message: err.message } });
    return;
  }

  if (request.user.role !== 'org_admin') {
    const err = AppError.forbidden('Org admin access required');
    await reply.code(403).send({ error: { code: err.code, message: err.message } });
    return;
  }

  if (!request.user.org_id) {
    const err = AppError.forbidden('Org admin access required');
    await reply.code(403).send({ error: { code: err.code, message: err.message } });
    return;
  }
}
