import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { env } from '@config/env';

export default fp(async function rateLimitPlugin(app: FastifyInstance) {
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    redis: app.redis,
    nameSpace: 'rl:',
    skipOnError: true,
    keyGenerator: (request) => {
      const forwarded = request.headers['x-forwarded-for'];
      const ip = Array.isArray(forwarded)
        ? (forwarded[0] ?? request.ip)
        : (forwarded ?? request.ip);
      return ip;
    },
  });
});
