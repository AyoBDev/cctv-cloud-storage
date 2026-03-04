import fp from 'fastify-plugin';
import fjwt from '@fastify/jwt';
import type { FastifyInstance } from 'fastify';
import { env } from '@config/env';

export default fp(async function jwtPlugin(app: FastifyInstance) {
  await app.register(fjwt, {
    secret: {
      private: env.JWT_PRIVATE_KEY,
      public: env.JWT_PUBLIC_KEY,
    },
    sign: {
      algorithm: 'RS256',
      expiresIn: env.JWT_ACCESS_EXPIRES_IN,
    },
    verify: {
      algorithms: ['RS256'],
    },
  });
});
