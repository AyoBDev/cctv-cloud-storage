import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '@middleware/require-user';
import { requireOrgAdmin } from '@middleware/require-org-admin';
import { isViewerAssigned } from '@services/assignment.service';
import { AppError } from '@utils/errors';

const cameraIdParamsSchema = z.object({
  cameraId: z.string().uuid(),
});

const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

const updateSettingsBodySchema = z
  .object({
    face_detection_enabled: z.boolean().optional(),
    face_detection_start_time: z
      .string()
      .regex(timeRegex, 'Must be HH:MM format')
      .nullable()
      .optional(),
    face_detection_end_time: z
      .string()
      .regex(timeRegex, 'Must be HH:MM format')
      .nullable()
      .optional(),
    alert_cooldown_minutes: z.number().int().min(1).max(1440).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export default async function cameraSettingsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/cameras/:cameraId/settings
  app.get('/', { preHandler: [requireUser] }, async (request, reply) => {
    const params = cameraIdParamsSchema.parse(request.params);
    const orgId = request.user.org_id!;

    if (request.user.role === 'viewer') {
      const assigned = await isViewerAssigned(app.db, params.cameraId, request.user.sub);
      if (!assigned) throw AppError.forbidden('Camera not assigned to you');
    }

    const rows = await app.db<
      Array<{
        id: string;
        org_id: string;
        face_detection_enabled: boolean;
        face_detection_start_time: string | null;
        face_detection_end_time: string | null;
        alert_cooldown_minutes: number;
      }>
    >`
      SELECT id, org_id, face_detection_enabled, face_detection_start_time,
             face_detection_end_time, alert_cooldown_minutes
      FROM cameras
      WHERE id = ${params.cameraId} AND org_id = ${orgId} AND is_active = true
    `;

    const camera = rows[0];
    if (!camera) throw AppError.notFound('Camera not found');

    return reply.code(200).send({
      face_detection_enabled: camera.face_detection_enabled,
      face_detection_start_time: camera.face_detection_start_time,
      face_detection_end_time: camera.face_detection_end_time,
      alert_cooldown_minutes: camera.alert_cooldown_minutes,
    });
  });

  // PATCH /api/v1/cameras/:cameraId/settings
  app.patch('/', { preHandler: [requireOrgAdmin] }, async (request, reply) => {
    const params = cameraIdParamsSchema.parse(request.params);
    const body = updateSettingsBodySchema.parse(request.body);
    const orgId = request.user.org_id!;

    const existing = await app.db<Array<{ id: string }>>`
      SELECT id FROM cameras
      WHERE id = ${params.cameraId} AND org_id = ${orgId} AND is_active = true
    `;
    if (!existing[0]) throw AppError.notFound('Camera not found');

    const rows = await app.db<
      Array<{
        face_detection_enabled: boolean;
        face_detection_start_time: string | null;
        face_detection_end_time: string | null;
        alert_cooldown_minutes: number;
      }>
    >`
      UPDATE cameras SET
        face_detection_enabled = COALESCE(${body.face_detection_enabled ?? null}::boolean, face_detection_enabled),
        face_detection_start_time = CASE
          WHEN ${body.face_detection_start_time !== undefined} THEN ${body.face_detection_start_time ?? null}::time
          ELSE face_detection_start_time
        END,
        face_detection_end_time = CASE
          WHEN ${body.face_detection_end_time !== undefined} THEN ${body.face_detection_end_time ?? null}::time
          ELSE face_detection_end_time
        END,
        alert_cooldown_minutes = COALESCE(${body.alert_cooldown_minutes ?? null}::integer, alert_cooldown_minutes)
      WHERE id = ${params.cameraId} AND org_id = ${orgId}
      RETURNING face_detection_enabled, face_detection_start_time, face_detection_end_time, alert_cooldown_minutes
    `;

    return reply.code(200).send(rows[0]);
  });
}
