import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loginSuperAdmin, refreshTokens, logout } from '@services/auth.service';
import { AppError } from '@utils/errors';
import { requireSuperAdmin } from '@middleware/require-super-admin';

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});

export default async function adminAuthRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/admin/auth/login
  app.post(
    '/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              accessToken: { type: 'string' },
              refreshToken: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = loginBodySchema.parse(request.body);
      const tokens = await loginSuperAdmin(app.db, app.redis, body.email, body.password);
      return reply.code(200).send(tokens);
    },
  );

  // POST /api/v1/admin/auth/refresh
  app.post(
    '/refresh',
    {
      schema: {
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: {
            refreshToken: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              accessToken: { type: 'string' },
              refreshToken: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = refreshBodySchema.parse(request.body);
      const tokens = await refreshTokens(app.db, app.redis, body.refreshToken);
      return reply.code(200).send(tokens);
    },
  );

  // POST /api/v1/admin/auth/logout
  app.post(
    '/logout',
    {
      schema: {
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: {
            refreshToken: { type: 'string' },
          },
        },
        response: {
          204: { type: 'null' },
        },
      },
      preHandler: [requireSuperAdmin],
    },
    async (request, reply) => {
      const body = refreshBodySchema.parse(request.body);
      await logout(app.redis, body.refreshToken);
      return reply.code(204).send();
    },
  );
}

export { AppError };
