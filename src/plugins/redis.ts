import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { env } from '@config/env';

export default fp(async function redisPlugin(app: FastifyInstance) {
  const redis = new Redis(env.REDIS_URL, {
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });

  await redis.connect();

  redis.on('error', (err) => {
    app.log.error({ err }, 'Redis connection error');
  });

  app.decorate('redis', redis);

  app.addHook('onClose', async () => {
    await redis.quit();
  });
});
