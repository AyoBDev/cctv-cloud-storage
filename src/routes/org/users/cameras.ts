import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrgAdmin } from '@middleware/require-org-admin';
import {
  addCamerasToViewer,
  removeCamerasFromViewer,
  replaceCamerasForViewer,
  listCamerasForViewer,
} from '@services/assignment.service';
import { invalidateOrgCameraCache } from '@services/camera.service';

const userIdParamsSchema = z.object({
  userId: z.string().uuid(),
});

const cameraIdsBodySchema = z.object({
  camera_ids: z.array(z.string().uuid()).min(1).max(100),
});

export default async function userCameraRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/org/users/:userId/cameras
  app.post(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      const body = cameraIdsBodySchema.parse(request.body);
      const orgId = request.user.org_id!;

      const assigned = await addCamerasToViewer(app.db, orgId, params.userId, body.camera_ids, request.user.sub);
      await invalidateOrgCameraCache(app.redis, orgId);

      return reply.code(200).send({ assigned });
    },
  );

  // GET /api/v1/org/users/:userId/cameras
  app.get(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      const orgId = request.user.org_id!;

      const cameras = await listCamerasForViewer(app.db, orgId, params.userId);
      return reply.code(200).send({ cameras });
    },
  );

  // PUT /api/v1/org/users/:userId/cameras
  app.put(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      const body = cameraIdsBodySchema.parse(request.body);
      const orgId = request.user.org_id!;

      const assigned = await replaceCamerasForViewer(app.db, orgId, params.userId, body.camera_ids, request.user.sub);
      await invalidateOrgCameraCache(app.redis, orgId);

      return reply.code(200).send({ assigned });
    },
  );

  // DELETE /api/v1/org/users/:userId/cameras
  app.delete(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      const body = cameraIdsBodySchema.parse(request.body);
      const orgId = request.user.org_id!;

      const removed = await removeCamerasFromViewer(app.db, orgId, params.userId, body.camera_ids);
      await invalidateOrgCameraCache(app.redis, orgId);

      return reply.code(200).send({ removed });
    },
  );
}
