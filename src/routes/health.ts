import type { FastifyInstance } from 'fastify';

export default async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              db: { type: 'string' },
              redis: { type: 'string' },
            },
          },
        },
      },
      config: { rateLimit: { max: 300 } },
    },
    async (_request, _reply) => {
      let dbStatus = 'ok';
      let redisStatus = 'ok';

      try {
        await app.db`SELECT 1`;
      } catch {
        dbStatus = 'error';
      }

      try {
        await app.redis.ping();
      } catch {
        redisStatus = 'error';
      }

      const status = dbStatus === 'ok' && redisStatus === 'ok' ? 'ok' : 'degraded';

      return { status, db: dbStatus, redis: redisStatus };
    },
  );
}
