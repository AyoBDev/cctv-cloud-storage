import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSuperAdmin } from '@middleware/require-super-admin';
import { listUsers, getUserById, updateUserStatus, deleteUser } from '@services/user.service';

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  orgId: z.string().uuid().optional(),
});

const userIdParamsSchema = z.object({
  userId: z.string().uuid(),
});

const updateUserBodySchema = z.object({
  is_active: z.boolean(),
});

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/admin/users
  app.get(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            orgId: { type: 'string', format: 'uuid' },
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
      preHandler: [requireSuperAdmin],
    },
    async (request, reply) => {
      const query = paginationQuerySchema.parse(request.query);
      const result = await listUsers(app.db, query.page, query.limit, query.orgId);
      return reply.code(200).send(result);
    },
  );

  // GET /api/v1/admin/users/:userId
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
              org_id: { type: 'string', nullable: true },
              is_active: { type: 'boolean' },
              created_at: { type: 'string' },
              updated_at: { type: 'string' },
            },
          },
        },
      },
      preHandler: [requireSuperAdmin],
    },
    async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      const user = await getUserById(app.db, params.userId);
      return reply.code(200).send(user);
    },
  );

  // PATCH /api/v1/admin/users/:userId
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
              org_id: { type: 'string', nullable: true },
              is_active: { type: 'boolean' },
              created_at: { type: 'string' },
              updated_at: { type: 'string' },
            },
          },
        },
      },
      preHandler: [requireSuperAdmin],
    },
    async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      const body = updateUserBodySchema.parse(request.body);
      const user = await updateUserStatus(app.db, params.userId, body.is_active);
      return reply.code(200).send(user);
    },
  );

  // DELETE /api/v1/admin/users/:userId
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
      preHandler: [requireSuperAdmin],
    },
    async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      await deleteUser(app.db, params.userId);
      return reply.code(204).send();
    },
  );
}
