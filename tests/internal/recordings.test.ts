import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Internal Recordings', () => {
  let app: FastifyInstance;
  let orgId: string;
  let cameraId: string;
  const internalSecret = process.env['INTERNAL_API_SECRET'] ?? 'test-internal-secret-1234567890';

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'rec-internal');
    orgId = org.orgId;

    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${org.orgAdminAccessToken}` },
      payload: { name: 'Recording Test Camera' },
    });
    cameraId = camRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('POST /internal/recordings', () => {
    it('creates a recording (201)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/recordings',
        headers: { 'x-internal-secret': internalSecret },
        payload: {
          org_id: orgId,
          camera_id: cameraId,
          s3_key: `orgs/${orgId}/cameras/${cameraId}/2026-05-10/14-30.mp4`,
          start_time: '2026-05-10T14:30:00.000Z',
          end_time: '2026-05-10T14:35:00.000Z',
          duration_seconds: 300,
          file_size_bytes: 15728640,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; camera_id: string; duration_seconds: number }>();
      expect(body.camera_id).toBe(cameraId);
      expect(body.duration_seconds).toBe(300);
    });

    it('handles duplicate gracefully', async () => {
      const payload = {
        org_id: orgId,
        camera_id: cameraId,
        s3_key: `orgs/${orgId}/cameras/${cameraId}/2026-05-10/14-35.mp4`,
        start_time: '2026-05-10T14:35:00.000Z',
        end_time: '2026-05-10T14:40:00.000Z',
        duration_seconds: 300,
        file_size_bytes: 15000000,
      };

      await app.inject({
        method: 'POST',
        url: '/internal/recordings',
        headers: { 'x-internal-secret': internalSecret },
        payload,
      });

      // Same start_time + camera_id = duplicate
      const res = await app.inject({
        method: 'POST',
        url: '/internal/recordings',
        headers: { 'x-internal-secret': internalSecret },
        payload,
      });

      expect(res.statusCode).toBe(201);
    });

    it('returns 401 without secret', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/recordings',
        payload: {
          org_id: orgId,
          camera_id: cameraId,
          s3_key: 'test.mp4',
          start_time: '2026-05-10T15:00:00.000Z',
          end_time: '2026-05-10T15:05:00.000Z',
          duration_seconds: 300,
          file_size_bytes: 1000,
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 400 with invalid payload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/recordings',
        headers: { 'x-internal-secret': internalSecret },
        payload: {
          org_id: 'not-a-uuid',
          camera_id: cameraId,
          s3_key: '',
          start_time: 'invalid',
          end_time: 'invalid',
          duration_seconds: -1,
          file_size_bytes: 0,
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /internal/cameras/active', () => {
    it('returns active cameras (200)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/cameras/active',
        headers: { 'x-internal-secret': internalSecret },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ cameras: Array<{ id: string; org_id: string; kvs_stream_name: string }> }>();
      expect(Array.isArray(body.cameras)).toBe(true);
    });

    it('returns 401 without secret', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/cameras/active',
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
