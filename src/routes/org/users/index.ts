import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrgAdmin } from '@middleware/require-org-admin';
import {
  listOrgUsers,
  createOrgUser,
  getOrgUserById,
  updateOrgUser,
  deleteOrgUser,
} from '@services/org-user.service';
import userCameraRoutes from './cameras';

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const userIdParamsSchema = z.object({
  userId: z.string().uuid(),
});

const createUserBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const updateUserBodySchema = z.object({
  is_active: z.boolean(),
});

export default async function orgUserRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/org/users
  app.get(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: { type: 'array' },
              pagination: {
                type: 'object',
                properties: {
                  page: { type: 'integer' },
                  limit: { type: 'integer' },
                  total: { type: 'integer' },
                },
              },
            },
          },
        },
      },
      preHandler: [requireOrgAdmin],
    },
    async (request, reply) => {
      const query = paginationQuerySchema.parse(request.query);
      const result = await listOrgUsers(app.db, request.user.org_id!, query.page, query.limit);
      return reply.code(200).send(result);
    },
  );

  // POST /api/v1/org/users
  app.post(
    '/',
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
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              email: { type: 'string' },
              role: { type: 'string' },
              org_id: { type: 'string' },
              is_active: { type: 'boolean' },
              created_at: { type: 'string' },
              updated_at: { type: 'string' },
            },
          },
        },
      },
      preHandler: [requireOrgAdmin],
    },
    async (request, reply) => {
      const body = createUserBodySchema.parse(request.body);
      const user = await createOrgUser(app.db, request.user.org_id!, body.email, body.password);
      return reply.code(201).send(user);
    },
  );

  // GET /api/v1/org/users/:userId
  app.get(
    '/:userId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              email: { type: 'string' },
              role: { type: 'string' },
              org_id: { type: 'string' },
              is_active: { type: 'boolean' },
              created_at: { type: 'string' },
              updated_at: { type: 'string' },
            },
          },
        },
      },
      preHandler: [requireOrgAdmin],
    },
    async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      const user = await getOrgUserById(app.db, request.user.org_id!, params.userId);
      return reply.code(200).send(user);
    },
  );

  // PATCH /api/v1/org/users/:userId
  app.patch(
    '/:userId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['is_active'],
          properties: {
            is_active: { type: 'boolean' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              email: { type: 'string' },
              role: { type: 'string' },
              org_id: { type: 'string' },
              is_active: { type: 'boolean' },
              created_at: { type: 'string' },
              updated_at: { type: 'string' },
            },
          },
        },
      },
      preHandler: [requireOrgAdmin],
    },
    async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      const body = updateUserBodySchema.parse(request.body);
      const user = await updateOrgUser(app.db, request.user.org_id!, params.userId, {
        is_active: body.is_active,
      });
      return reply.code(200).send(user);
    },
  );

  // DELETE /api/v1/org/users/:userId
  app.delete(
    '/:userId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', format: 'uuid' } },
        },
        response: {
          204: { type: 'null' },
        },
      },
      preHandler: [requireOrgAdmin],
    },
    async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      await deleteOrgUser(app.db, request.user.org_id!, params.userId);
      return reply.code(204).send();
    },
  );

  // User camera assignment routes: /api/v1/org/users/:userId/cameras/*
  await app.register(userCameraRoutes, { prefix: '/:userId/cameras' });
}
