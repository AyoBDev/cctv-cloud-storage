import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalSecret } from '@middleware/require-internal-secret';
import { updateCameraStatus } from '@services/camera.service';

const statusUpdateBodySchema = z.object({
  kvs_stream_name: z.string().min(1),
  status: z.enum(['online', 'offline']),
});

export default async function internalCameraRoutes(app: FastifyInstance): Promise<void> {
  // POST /internal/cameras/status
  app.post(
    '/status',
    {
      schema: {
        body: {
          type: 'object',
          required: ['kvs_stream_name', 'status'],
          properties: {
            kvs_stream_name: { type: 'string', minLength: 1 },
            status: { type: 'string', enum: ['online', 'offline'] },
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
      preHandler: [requireInternalSecret],
    },
    async (request, reply) => {
      const body = statusUpdateBodySchema.parse(request.body);
      await updateCameraStatus(app.db, app.redis, body.kvs_stream_name, body.status);
      return reply.code(200).send({ message: 'Status updated' });
    },
  );
}
