import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSuperAdmin } from '@middleware/require-super-admin';
import { listAllCameras } from '@services/camera.service';

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  org_id: z.string().uuid().optional(),
});

export default async function adminCameraRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/admin/cameras
  app.get(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            org_id: { type: 'string', format: 'uuid' },
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
      const result = await listAllCameras(app.db, query.page, query.limit, query.org_id);
      return reply.code(200).send(result);
    },
  );
}
