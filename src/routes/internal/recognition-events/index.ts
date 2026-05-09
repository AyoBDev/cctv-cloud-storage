import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalSecret } from '@middleware/require-internal-secret';
import { createRecognitionEvent } from '@services/recognition-event.service';

const createEventBodySchema = z.object({
  org_id: z.string().uuid(),
  camera_id: z.string().uuid(),
  image_bytes: z.string().min(1),
  confidence: z.number().min(0).max(100),
  face_profile_id: z.string().uuid().nullable(),
  event_type: z.enum(['known_face', 'unknown_face']),
});

export default async function internalRecognitionEventRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/recognition-events',
    { preHandler: [requireInternalSecret] },
    async (request, reply) => {
      const body = createEventBodySchema.parse(request.body);
      const event = await createRecognitionEvent(app.db, app.redis, body);
      return reply.code(201).send(event);
    },
  );
}
