import type { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '@utils/errors';
import { env } from '@config/env';

export async function requireInternalSecret(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const secret = request.headers['x-internal-secret'];

  if (!secret || secret !== env.INTERNAL_API_SECRET) {
    const err = AppError.unauthorized('Invalid or missing internal secret');
    await reply.code(401).send({ error: { code: err.code, message: err.message } });
  }
}
