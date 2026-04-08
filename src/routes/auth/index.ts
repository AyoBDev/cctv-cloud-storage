import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loginOrgUser, refreshTokens, logout, changePassword } from '@services/auth.service';
import { requireUser } from '@middleware/require-user';

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});

const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(8),
  newPassword: z.string().min(8),
});

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/auth/login
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
      const tokens = await loginOrgUser(app.db, app.redis, body.email, body.password);
      return reply.code(200).send(tokens);
    },
  );

  // POST /api/v1/auth/refresh
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

  // POST /api/v1/auth/logout
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
      preHandler: [requireUser],
    },
    async (request, reply) => {
      const body = refreshBodySchema.parse(request.body);
      await logout(app.redis, body.refreshToken);
      return reply.code(204).send();
    },
  );

  // POST /api/v1/auth/change-password
  app.post(
    '/change-password',
    {
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', minLength: 8 },
            newPassword: { type: 'string', minLength: 8 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              message: { type: 'string' },
            },
          },
        },
      },
      preHandler: [requireUser],
    },
    async (request, reply) => {
      const body = changePasswordBodySchema.parse(request.body);
      await changePassword(app.db, request.user.sub, body.currentPassword, body.newPassword);
      return reply.code(200).send({ message: 'Password changed successfully' });
    },
  );
}
