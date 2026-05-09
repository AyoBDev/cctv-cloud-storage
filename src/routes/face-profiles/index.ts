import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '@middleware/require-user';
import { requireOrgAdmin } from '@middleware/require-org-admin';
import {
  createFaceProfile,
  listFaceProfiles,
  getFaceProfileById,
  deleteFaceProfile,
} from '@services/face-profile.service';
import { AppError } from '@utils/errors';

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const profileIdParamsSchema = z.object({
  id: z.string().uuid(),
});

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

export default async function faceProfileRoutes(app: FastifyInstance): Promise<void> {
  await app.register(import('@fastify/multipart'), {
    limits: { fileSize: MAX_FILE_SIZE },
  });

  // POST /api/v1/face-profiles
  app.post(
    '/',
    { preHandler: [requireUser] },
    async (request, reply) => {
      const data = await request.file();
      if (!data) throw AppError.badRequest('Multipart form data required');

      const fields = data.fields;
      const labelField = fields['label'];
      if (!labelField || !('value' in labelField) || typeof labelField.value !== 'string') {
        throw AppError.badRequest('Label is required');
      }
      const label = labelField.value;
      if (label.length === 0 || label.length > 255) {
        throw AppError.badRequest('Label must be between 1 and 255 characters');
      }

      if (!data.mimetype || !ALLOWED_MIME_TYPES.includes(data.mimetype)) {
        throw AppError.badRequest('Image must be JPEG or PNG');
      }

      const buffer = await data.toBuffer();
      if (buffer.length === 0) {
        throw AppError.badRequest('Image file is required');
      }

      const profile = await createFaceProfile(
        app.db,
        app.redis,
        request.user.org_id!,
        request.user.sub,
        label,
        buffer,
        data.mimetype,
      );

      return reply.code(201).send(profile);
    },
  );

  // GET /api/v1/face-profiles
  app.get(
    '/',
    { preHandler: [requireUser] },
    async (request, reply) => {
      const query = paginationQuerySchema.parse(request.query);
      const result = await listFaceProfiles(
        app.db,
        app.redis,
        request.user.org_id!,
        query.page,
        query.limit,
      );
      return reply.code(200).send(result);
    },
  );

  // GET /api/v1/face-profiles/:id
  app.get(
    '/:id',
    { preHandler: [requireUser] },
    async (request, reply) => {
      const params = profileIdParamsSchema.parse(request.params);
      const profile = await getFaceProfileById(app.db, request.user.org_id!, params.id);
      return reply.code(200).send(profile);
    },
  );

  // DELETE /api/v1/face-profiles/:id
  app.delete(
    '/:id',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = profileIdParamsSchema.parse(request.params);
      await deleteFaceProfile(app.db, app.redis, request.user.org_id!, params.id);
      return reply.code(204).send();
    },
  );
}
