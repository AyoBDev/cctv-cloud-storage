import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSuperAdmin } from '@middleware/require-super-admin';
import {
  listOrganizations,
  createOrganizationWithAdmin,
  getOrganizationById,
  updateOrganization,
  deleteOrganization,
} from '@services/organization.service';

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const orgIdParamsSchema = z.object({
  orgId: z.string().uuid(),
});

const createOrgBodySchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().regex(/^[a-z0-9-]+$/).max(100),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8),
});

const updateOrgBodySchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    slug: z.string().regex(/^[a-z0-9-]+$/).max(100).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export default async function organizationRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/admin/organizations
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
      preHandler: [requireSuperAdmin],
    },
    async (request, reply) => {
      const query = paginationQuerySchema.parse(request.query);
      const result = await listOrganizations(app.db, query.page, query.limit);
      return reply.code(200).send(result);
    },
  );

  // POST /api/v1/admin/organizations
  app.post(
    '/',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'slug', 'adminEmail', 'adminPassword'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            slug: { type: 'string', maxLength: 100 },
            adminEmail: { type: 'string', format: 'email' },
            adminPassword: { type: 'string', minLength: 8 },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              slug: { type: 'string' },
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
      const body = createOrgBodySchema.parse(request.body);
      const org = await createOrganizationWithAdmin(app.db, body);
      return reply.code(201).send(org);
    },
  );

  // GET /api/v1/admin/organizations/:orgId
  app.get(
    '/:orgId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['orgId'],
          properties: { orgId: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              slug: { type: 'string' },
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
      const params = orgIdParamsSchema.parse(request.params);
      const org = await getOrganizationById(app.db, params.orgId);
      return reply.code(200).send(org);
    },
  );

  // PATCH /api/v1/admin/organizations/:orgId
  app.patch(
    '/:orgId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['orgId'],
          properties: { orgId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            slug: { type: 'string', maxLength: 100 },
            is_active: { type: 'boolean' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              slug: { type: 'string' },
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
      const params = orgIdParamsSchema.parse(request.params);
      const body = updateOrgBodySchema.parse(request.body);
      const updates: { name?: string; slug?: string; is_active?: boolean } = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.slug !== undefined) updates.slug = body.slug;
      if (body.is_active !== undefined) updates.is_active = body.is_active;
      const org = await updateOrganization(app.db, params.orgId, updates);
      return reply.code(200).send(org);
    },
  );

  // DELETE /api/v1/admin/organizations/:orgId
  app.delete(
    '/:orgId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['orgId'],
          properties: { orgId: { type: 'string', format: 'uuid' } },
        },
        response: {
          204: { type: 'null' },
        },
      },
      preHandler: [requireSuperAdmin],
    },
    async (request, reply) => {
      const params = orgIdParamsSchema.parse(request.params);
      await deleteOrganization(app.db, params.orgId);
      return reply.code(204).send();
    },
  );
}
