import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrgAdmin } from '@middleware/require-org-admin';
import {
  getCameraFaceDetectionSettings,
  updateCameraFaceDetectionSettings,
} from '@services/face-detection.service';
import { AppError } from '@utils/errors';

const cameraIdParamsSchema = z.object({
  cameraId: z.string().uuid(),
});

const scheduleSchema = z
  .object({
    start_time: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
    end_time: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
  })
  .nullable();

const updateBodySchema = z
  .object({
    enabled: z.boolean().nullable().optional(),
    duration_minutes: z.number().int().positive().nullable().optional(),
    schedule: scheduleSchema.optional(),
  })
  .refine((data) => !(data.duration_minutes && data.schedule), {
    message: 'duration_minutes and schedule are mutually exclusive',
  });

export default async function cameraFaceDetectionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [requireOrgAdmin] }, async (request, reply) => {
    const params = cameraIdParamsSchema.parse(request.params);
    const settings = await getCameraFaceDetectionSettings(
      app.db,
      request.user.org_id!,
      params.cameraId,
    );
    return reply.code(200).send(settings);
  });

  app.patch('/', { preHandler: [requireOrgAdmin] }, async (request, reply) => {
    const body = updateBodySchema.parse(request.body);

    if (body.duration_minutes && body.schedule) {
      throw AppError.badRequest('duration_minutes and schedule are mutually exclusive');
    }

    const settings = await updateCameraFaceDetectionSettings(
      app.db,
      request.user.org_id!,
      (request.params as { cameraId: string }).cameraId,
      body,
    );
    return reply.code(200).send(settings);
  });
}
