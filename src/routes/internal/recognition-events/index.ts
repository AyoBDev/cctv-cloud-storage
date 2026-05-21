import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalSecret } from '@middleware/require-internal-secret';
import {
  createRecognitionEvent,
  recordRecognitionEvent,
} from '@services/recognition-event.service';

const createEventBodySchema = z.object({
  org_id: z.string().uuid(),
  camera_id: z.string().uuid(),
  image_bytes: z.string().min(1).optional(),
  thumbnail_key: z.string().min(1).optional(),
  confidence: z.number().min(0).max(100),
  face_profile_id: z.string().uuid().nullable(),
  event_type: z.enum(['known_face', 'unknown_face']),
});

interface CameraFaceSettings {
  face_detection_enabled: boolean;
  face_detection_start_time: string | null;
  face_detection_end_time: string | null;
  alert_cooldown_minutes: number;
  timezone: string;
}

function isFaceDetectionActive(settings: CameraFaceSettings): boolean {
  if (!settings.face_detection_enabled) return false;

  if (!settings.face_detection_start_time || !settings.face_detection_end_time) return true;

  const now = new Date();
  const tz = settings.timezone || 'UTC';
  const timeStr = now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false }).slice(0, 5);

  const start = settings.face_detection_start_time.slice(0, 5);
  const end = settings.face_detection_end_time.slice(0, 5);

  if (start <= end) {
    return timeStr >= start && timeStr <= end;
  }
  return timeStr >= start || timeStr <= end;
}

export default async function internalRecognitionEventRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/recognition-events',
    { preHandler: [requireInternalSecret] },
    async (request, reply) => {
      const body = createEventBodySchema.parse(request.body);

      // Check camera face detection settings
      const cameraRows = await app.db<CameraFaceSettings[]>`
        SELECT face_detection_enabled, face_detection_start_time,
               face_detection_end_time, alert_cooldown_minutes, timezone
        FROM cameras
        WHERE id = ${body.camera_id} AND is_active = true
      `;

      const cameraSettings = cameraRows[0];
      if (!cameraSettings) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Camera not found or inactive' },
        });
      }

      if (!isFaceDetectionActive(cameraSettings)) {
        return reply.code(200).send({ skipped: true, reason: 'face_detection_disabled' });
      }

      // Check per-camera alert cooldown
      const cooldownKey = `alert-cooldown:${body.camera_id}`;
      const onCooldown = await app.redis.get(cooldownKey);
      if (onCooldown && body.event_type === 'unknown_face') {
        return reply.code(200).send({ skipped: true, reason: 'alert_cooldown' });
      }

      // Set cooldown for this camera
      if (body.event_type === 'unknown_face') {
        await app.redis.setex(cooldownKey, cameraSettings.alert_cooldown_minutes * 60, '1');
      }

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

      if (!body.image_bytes) {
        return reply.code(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Either image_bytes or thumbnail_key is required',
          },
        });
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
