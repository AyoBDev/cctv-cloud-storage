import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '@middleware/require-user';
import { requireOrgAdmin } from '@middleware/require-org-admin';
import {
  createCamera,
  listCameras,
  getCameraById,
  updateCamera,
  deactivateCamera,
} from '@services/camera.service';
import { issueCredentials, getCredentialEndpoint } from '@services/iot.service';
import { env } from '@config/env';
import { AppError } from '@utils/errors';
import cameraViewerRoutes from './viewers';

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const cameraIdParamsSchema = z.object({
  cameraId: z.string().uuid(),
});

const createCameraBodySchema = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
    .min(1)
    .max(100)
    .optional(),
  location: z.string().max(255).optional(),
  timezone: z.string().max(50).optional(),
  rtsp_url: z.string().url().optional(),
});

const updateCameraBodySchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    location: z.string().max(255).optional(),
    timezone: z.string().max(50).optional(),
    rtsp_url: z.string().url().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export default async function cameraRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/cameras
  app.post(
    '/',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            slug: { type: 'string', maxLength: 100 },
            location: { type: 'string', maxLength: 255 },
            timezone: { type: 'string', maxLength: 50 },
            rtsp_url: { type: 'string', format: 'uri' },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              org_id: { type: 'string' },
              name: { type: 'string' },
              slug: { type: 'string' },
              location: { type: 'string', nullable: true },
              timezone: { type: 'string' },
              kvs_stream_name: { type: 'string' },
              kvs_stream_arn: { type: 'string', nullable: true },
              status: { type: 'string', enum: ['provisioning', 'online', 'offline', 'inactive'] },
              is_active: { type: 'boolean' },
              created_at: { type: 'string' },
              updated_at: { type: 'string' },
            },
          },
        },
      },
      preHandler: [requireOrgAdmin],
    },
    async (request, reply) => {
      const body = createCameraBodySchema.parse(request.body);
      const data: {
        name: string;
        slug?: string;
        location?: string;
        timezone?: string;
        rtsp_url?: string;
      } = {
        name: body.name,
      };
      if (body.slug !== undefined) data.slug = body.slug;
      if (body.location !== undefined) data.location = body.location;
      if (body.timezone !== undefined) data.timezone = body.timezone;
      if (body.rtsp_url !== undefined) data.rtsp_url = body.rtsp_url;

      const camera = await createCamera(
        app.db,
        app.redis,
        app.kvs,
        app.kms,
        app.iot,
        request.user.org_id!,
        data,
      );
      return reply.code(201).send(camera);
    },
  );

  // GET /api/v1/cameras
  app.get(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: { type: 'array' },
              pagination: {
                type: 'object',
                properties: {
                  page: { type: 'integer' },
                  limit: { type: 'integer' },
                  total: { type: 'integer' },
                },
              },
            },
          },
        },
      },
      preHandler: [requireUser],
    },
    async (request, reply) => {
      const query = paginationQuerySchema.parse(request.query);
      const result = await listCameras(
        app.db,
        app.redis,
        request.user.org_id!,
        query.page,
        query.limit,
      );
      return reply.code(200).send(result);
    },
  );

  // GET /api/v1/cameras/:cameraId
  app.get(
    '/:cameraId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cameraId'],
          properties: { cameraId: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              org_id: { type: 'string' },
              name: { type: 'string' },
              slug: { type: 'string' },
              location: { type: 'string', nullable: true },
              timezone: { type: 'string' },
              rtsp_url: { type: 'string' },
              kvs_stream_name: { type: 'string' },
              kvs_stream_arn: { type: 'string', nullable: true },
              status: { type: 'string', enum: ['provisioning', 'online', 'offline', 'inactive'] },
              is_active: { type: 'boolean' },
              created_at: { type: 'string' },
              updated_at: { type: 'string' },
            },
          },
        },
      },
      preHandler: [requireUser],
    },
    async (request, reply) => {
      const params = cameraIdParamsSchema.parse(request.params);
      const camera = await getCameraById(app.db, app.kms, request.user.org_id!, params.cameraId);
      return reply.code(200).send(camera);
    },
  );

  // PATCH /api/v1/cameras/:cameraId
  app.patch(
    '/:cameraId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cameraId'],
          properties: { cameraId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            location: { type: 'string', maxLength: 255 },
            timezone: { type: 'string', maxLength: 50 },
            rtsp_url: { type: 'string', format: 'uri' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              org_id: { type: 'string' },
              name: { type: 'string' },
              slug: { type: 'string' },
              location: { type: 'string', nullable: true },
              timezone: { type: 'string' },
              kvs_stream_name: { type: 'string' },
              kvs_stream_arn: { type: 'string', nullable: true },
              status: { type: 'string', enum: ['provisioning', 'online', 'offline', 'inactive'] },
              is_active: { type: 'boolean' },
              created_at: { type: 'string' },
              updated_at: { type: 'string' },
            },
          },
        },
      },
      preHandler: [requireOrgAdmin],
    },
    async (request, reply) => {
      const params = cameraIdParamsSchema.parse(request.params);
      const body = updateCameraBodySchema.parse(request.body);
      const updates: { name?: string; location?: string; timezone?: string; rtsp_url?: string } =
        {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.location !== undefined) updates.location = body.location;
      if (body.timezone !== undefined) updates.timezone = body.timezone;
      if (body.rtsp_url !== undefined) updates.rtsp_url = body.rtsp_url;

      const camera = await updateCamera(
        app.db,
        app.redis,
        app.kms,
        request.user.org_id!,
        params.cameraId,
        updates,
      );
      return reply.code(200).send(camera);
    },
  );

  // DELETE /api/v1/cameras/:cameraId
  app.delete(
    '/:cameraId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cameraId'],
          properties: { cameraId: { type: 'string', format: 'uuid' } },
        },
        response: {
          204: { type: 'null' },
        },
      },
      preHandler: [requireOrgAdmin],
    },
    async (request, reply) => {
      const params = cameraIdParamsSchema.parse(request.params);
      await deactivateCamera(
        app.db,
        app.redis,
        app.kvs,
        app.iot,
        request.user.org_id!,
        params.cameraId,
      );
      return reply.code(204).send();
    },
  );

  // GET /api/v1/cameras/:cameraId/credentials
  app.get(
    '/:cameraId/credentials',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cameraId'],
          properties: { cameraId: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              device_cert: { type: 'string' },
              private_key: { type: 'string' },
              root_ca_url: { type: 'string' },
              iot_credential_endpoint: { type: 'string' },
              kvs_stream_name: { type: 'string' },
              role_alias: { type: 'string' },
              region: { type: 'string' },
            },
          },
        },
      },
      preHandler: [requireOrgAdmin],
    },
    async (request, reply) => {
      const params = cameraIdParamsSchema.parse(request.params);
      const orgId = request.user.org_id!;

      // Fetch camera and verify ownership
      const rows = await app.db<
        Array<{
          id: string;
          org_id: string;
          iot_thing_name: string | null;
          kvs_stream_name: string;
          credentials_issued: boolean;
          is_active: boolean;
        }>
      >`
        SELECT id, org_id, iot_thing_name, kvs_stream_name, credentials_issued, is_active
        FROM cameras
        WHERE id = ${params.cameraId} AND is_active = true
      `;

      const camera = rows[0];
      if (!camera) throw AppError.notFound('Camera not found');
      if (camera.org_id !== orgId) throw AppError.forbidden('Access denied');
      if (camera.credentials_issued) {
        throw AppError.conflict('Credentials already issued. Use rotate endpoint to reissue.');
      }
      if (!camera.iot_thing_name) {
        throw AppError.badRequest('Camera has no IoT Thing provisioned');
      }

      // Issue credentials
      const creds = await issueCredentials(app.iot, camera.iot_thing_name, env.IOT_POLICY_NAME);

      // Get cached credential endpoint
      const endpoint = await getCredentialEndpoint(app.iot);

      // Update DB with cert details
      await app.db`
        UPDATE cameras
        SET iot_certificate_id = ${creds.certificateId},
            iot_certificate_arn = ${creds.certificateArn},
            credentials_issued = true,
            credentials_issued_at = now()
        WHERE id = ${params.cameraId}
      `;

      return reply.code(200).send({
        device_cert: creds.certificatePem,
        private_key: creds.privateKey,
        root_ca_url: 'https://www.amazontrust.com/repository/AmazonRootCA1.pem',
        iot_credential_endpoint: endpoint,
        kvs_stream_name: camera.kvs_stream_name,
        role_alias: env.IOT_ROLE_ALIAS,
        region: env.AWS_REGION,
      });
    },
  );

  // Camera viewer assignment routes: /api/v1/cameras/:cameraId/viewers/*
  await app.register(cameraViewerRoutes, { prefix: '/:cameraId/viewers' });
}
