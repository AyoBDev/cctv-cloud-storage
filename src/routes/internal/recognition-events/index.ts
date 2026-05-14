import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalSecret } from '@middleware/require-internal-secret';
import { createRecognitionEvent, recordRecognitionEvent } from '@services/recognition-event.service';

const createEventBodySchema = z.object({
  org_id: z.string().uuid(),
  camera_id: z.string().uuid(),
  image_bytes: z.string().min(1).optional(),
  thumbnail_key: z.string().min(1).optional(),
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

      // If thumbnail_key is provided, skip Rekognition (Lambda already did face search)
      if (body.thumbnail_key) {
        const event = await recordRecognitionEvent(app.db, app.redis, {
          org_id: body.org_id,
          camera_id: body.camera_id,
          confidence: body.confidence,
          face_profile_id: body.face_profile_id,
          event_type: body.event_type,
          thumbnail_key: body.thumbnail_key,
        });
        return reply.code(201).send(event);
      }

      // Legacy path: image_bytes provided, do full Rekognition search
      if (!body.image_bytes) {
        return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Either image_bytes or thumbnail_key is required' } });
      }

      const event = await createRecognitionEvent(app.db, app.redis, {
        org_id: body.org_id,
        camera_id: body.camera_id,
        image_bytes: body.image_bytes,
        confidence: body.confidence,
        face_profile_id: body.face_profile_id,
        event_type: body.event_type,
      });
      return reply.code(201).send(event);
    },
  );
}
