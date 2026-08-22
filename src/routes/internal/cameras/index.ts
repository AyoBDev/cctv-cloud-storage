import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalSecret } from '@middleware/require-internal-secret';
import {
  updateCameraStatus,
  getReconcilableCameras,
  reconcileCameraStatuses,
} from '@services/camera.service';
import { isFaceDetectionActive } from '@services/face-detection.service';
import { env } from '@config/env';

const statusUpdateBodySchema = z.object({
  kvs_stream_name: z.string().min(1),
  status: z.enum(['online', 'offline']),
});

const reconcileBodySchema = z.object({
  updates: z.array(
    z.object({
      kvs_stream_name: z.string().min(1),
      has_media: z.boolean(),
    }),
  ),
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

  // GET /internal/cameras/reconcile-list — stream names to probe for media
  app.get('/reconcile-list', { preHandler: [requireInternalSecret] }, async (_request, reply) => {
    const cameras = await getReconcilableCameras(app.db);
    return reply.code(200).send({ cameras });
  });

  // POST /internal/cameras/reconcile — batch status update from observed media
  app.post(
    '/reconcile',
    {
      schema: {
        body: {
          type: 'object',
          required: ['updates'],
          properties: {
            updates: {
              type: 'array',
              items: {
                type: 'object',
                required: ['kvs_stream_name', 'has_media'],
                properties: {
                  kvs_stream_name: { type: 'string', minLength: 1 },
                  has_media: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
      preHandler: [requireInternalSecret],
    },
    async (request, reply) => {
      const body = reconcileBodySchema.parse(request.body);
      const results = await reconcileCameraStatuses(
        app.db,
        app.redis,
        body.updates,
        env.RECONCILE_GRACE_SECONDS,
      );
      return reply.code(200).send({ results });
    },
  );

  // GET /internal/cameras/:cameraId/face-detection-active
  app.get(
    '/:cameraId/face-detection-active',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cameraId'],
          properties: { cameraId: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              active: { type: 'boolean' },
            },
          },
        },
      },
      preHandler: [requireInternalSecret],
    },
    async (request, reply) => {
      const { cameraId } = request.params as { cameraId: string };
      const active = await isFaceDetectionActive(app.db, cameraId);
      return reply.code(200).send({ active });
    },
  );
}
