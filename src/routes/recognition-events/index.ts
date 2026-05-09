import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '@middleware/require-user';
import { listRecognitionEvents, getRecognitionEventById } from '@services/recognition-event.service';

const listQuerySchema = z.object({
  camera_id: z.string().uuid().optional(),
  face_profile_id: z.string().uuid().optional(),
  event_type: z.enum(['known_face', 'unknown_face']).optional(),
  unknown_only: z.coerce.boolean().optional(),
  min_confidence: z.coerce.number().min(0).max(100).optional(),
  max_confidence: z.coerce.number().min(0).max(100).optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const eventIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export default async function recognitionEventRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    { preHandler: [requireUser] },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      const result = await listRecognitionEvents(app.db, request.user.org_id!, query);
      return reply.code(200).send(result);
    },
  );

  app.get(
    '/:id',
    { preHandler: [requireUser] },
    async (request, reply) => {
      const params = eventIdParamsSchema.parse(request.params);
      const event = await getRecognitionEventById(app.db, request.user.org_id!, params.id);
      return reply.code(200).send(event);
    },
  );
}
