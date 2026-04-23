import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrgAdmin } from '@middleware/require-org-admin';
import {
  addViewersToCamera,
  removeViewersFromCamera,
  replaceViewersForCamera,
  listViewersForCamera,
} from '@services/assignment.service';
import { invalidateOrgCameraCache } from '@services/camera.service';

const cameraIdParamsSchema = z.object({
  cameraId: z.string().uuid(),
});

const userIdsBodySchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(100),
});

export default async function cameraViewerRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/cameras/:cameraId/viewers
  app.post(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = cameraIdParamsSchema.parse(request.params);
      const body = userIdsBodySchema.parse(request.body);
      const orgId = request.user.org_id!;

      const assigned = await addViewersToCamera(app.db, orgId, params.cameraId, body.user_ids, request.user.sub);
      await invalidateOrgCameraCache(app.redis, orgId);

      return reply.code(200).send({ assigned });
    },
  );

  // GET /api/v1/cameras/:cameraId/viewers
  app.get(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = cameraIdParamsSchema.parse(request.params);
      const orgId = request.user.org_id!;

      const viewers = await listViewersForCamera(app.db, orgId, params.cameraId);
      return reply.code(200).send({ viewers });
    },
  );

  // PUT /api/v1/cameras/:cameraId/viewers
  app.put(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = cameraIdParamsSchema.parse(request.params);
      const body = userIdsBodySchema.parse(request.body);
      const orgId = request.user.org_id!;

      const assigned = await replaceViewersForCamera(app.db, orgId, params.cameraId, body.user_ids, request.user.sub);
      await invalidateOrgCameraCache(app.redis, orgId);

      return reply.code(200).send({ assigned });
    },
  );

  // DELETE /api/v1/cameras/:cameraId/viewers
  app.delete(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = cameraIdParamsSchema.parse(request.params);
      const body = userIdsBodySchema.parse(request.body);
      const orgId = request.user.org_id!;

      const removed = await removeViewersFromCamera(app.db, orgId, params.cameraId, body.user_ids);
      await invalidateOrgCameraCache(app.redis, orgId);

      return reply.code(200).send({ removed });
    },
  );
}
