import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalSecret } from '@middleware/require-internal-secret';
import { createRecording, getActiveCameras } from '@services/recording.service';

const createRecordingBodySchema = z.object({
  org_id: z.string().uuid(),
  camera_id: z.string().uuid(),
  s3_key: z.string().min(1),
  start_time: z.string().datetime(),
  end_time: z.string().datetime(),
  duration_seconds: z.number().int().positive(),
  file_size_bytes: z.number().int().positive(),
});

export default async function internalRecordingRoutes(app: FastifyInstance): Promise<void> {
  // POST /internal/recordings
  app.post(
    '/recordings',
    { preHandler: [requireInternalSecret] },
    async (request, reply) => {
      const body = createRecordingBodySchema.parse(request.body);
      const recording = await createRecording(app.db, body);
      return reply.code(201).send(recording);
    },
  );

  // GET /internal/cameras/active
  app.get(
    '/cameras/active',
    { preHandler: [requireInternalSecret] },
    async (_request, reply) => {
      const cameras = await getActiveCameras(app.db);
      return reply.code(200).send({ cameras });
    },
  );
}
