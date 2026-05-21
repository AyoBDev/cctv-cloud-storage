import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '@middleware/require-user';
import { isViewerAssigned } from '@services/assignment.service';
import {
  listRecordings,
  getRecordingById,
  getRecordingDownload,
} from '@services/recording.service';
import { AppError } from '@utils/errors';

const cameraIdParamsSchema = z.object({
  cameraId: z.string().uuid(),
});

const recordingIdParamsSchema = z.object({
  cameraId: z.string().uuid(),
  recordingId: z.string().uuid(),
});

const listQuerySchema = z.object({
  start_date: z.string().datetime(),
  end_date: z.string().datetime(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export default async function cameraRecordingRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/cameras/:cameraId/recordings
  app.get('/', { preHandler: [requireUser] }, async (request, reply) => {
    const params = cameraIdParamsSchema.parse(request.params);
    const query = listQuerySchema.parse(request.query);
    const orgId = request.user.org_id!;

    // Viewers can only access assigned cameras
    if (request.user.role === 'viewer') {
      const assigned = await isViewerAssigned(app.db, params.cameraId, request.user.sub);
      if (!assigned) {
        throw AppError.forbidden('Camera not assigned to you');
      }
    }

    const result = await listRecordings(
      app.db,
      orgId,
      params.cameraId,
      query.start_date,
      query.end_date,
      query.cursor,
      query.limit,
    );

    return reply.code(200).send(result);
  });

  // GET /api/v1/cameras/:cameraId/recordings/:recordingId
  app.get('/:recordingId', { preHandler: [requireUser] }, async (request, reply) => {
    const params = recordingIdParamsSchema.parse(request.params);
    const orgId = request.user.org_id!;

    if (request.user.role === 'viewer') {
      const assigned = await isViewerAssigned(app.db, params.cameraId, request.user.sub);
      if (!assigned) {
        throw AppError.forbidden('Camera not assigned to you');
      }
    }

    const recording = await getRecordingById(app.db, orgId, params.cameraId, params.recordingId);
    return reply.code(200).send(recording);
  });

  // GET /api/v1/cameras/:cameraId/recordings/:recordingId/download
  app.get('/:recordingId/download', { preHandler: [requireUser] }, async (request, reply) => {
    const params = recordingIdParamsSchema.parse(request.params);
    const orgId = request.user.org_id!;

    if (request.user.role === 'viewer') {
      const assigned = await isViewerAssigned(app.db, params.cameraId, request.user.sub);
      if (!assigned) {
        throw AppError.forbidden('Camera not assigned to you');
      }
    }

    const download = await getRecordingDownload(app.db, orgId, params.cameraId, params.recordingId);
    return reply.code(200).send(download);
  });
}
