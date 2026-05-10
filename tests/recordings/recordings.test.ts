import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Recordings', () => {
  let app: FastifyInstance;
  let orgId: string;
  let orgAdminToken: string;
  let cameraId: string;
  let recordingId: string;
  const internalSecret = process.env['INTERNAL_API_SECRET'] ?? 'test-internal-secret-1234567890';

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'rec-pub');
    orgId = org.orgId;
    orgAdminToken = org.orgAdminAccessToken;

    // Create camera
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminToken}` },
      payload: { name: 'Recordings Camera' },
    });
    cameraId = camRes.json<{ id: string }>().id;

    // Create recordings via internal endpoint
    for (let i = 0; i < 3; i++) {
      const minute = i * 5;
      const padded = String(minute).padStart(2, '0');
      const res = await app.inject({
        method: 'POST',
        url: '/internal/recordings',
        headers: { 'x-internal-secret': internalSecret },
        payload: {
          org_id: orgId,
          camera_id: cameraId,
          s3_key: `orgs/${orgId}/cameras/${cameraId}/2026-05-10/14-${padded}.mp4`,
          start_time: `2026-05-10T14:${padded}:00.000Z`,
          end_time: `2026-05-10T14:${String(minute + 5).padStart(2, '0')}:00.000Z`,
          duration_seconds: 300,
          file_size_bytes: 15000000 + i * 1000,
        },
      });
      if (i === 0) {
        recordingId = res.json<{ id: string }>().id;
      }
    }
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('GET /api/v1/cameras/:cameraId/recordings', () => {
    it('lists recordings with date filter (200)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/recordings?start_date=2026-05-10T00:00:00.000Z&end_date=2026-05-10T23:59:59.000Z`,
        headers: { authorization: `Bearer ${orgAdminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        data: unknown[];
        pagination: { cursor: string | null; has_more: boolean };
      }>();
      expect(body.data.length).toBe(3);
      expect(body.pagination.has_more).toBe(false);
    });

    it('respects limit and returns cursor', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/recordings?start_date=2026-05-10T00:00:00.000Z&end_date=2026-05-10T23:59:59.000Z&limit=2`,
        headers: { authorization: `Bearer ${orgAdminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        data: unknown[];
        pagination: { cursor: string | null; has_more: boolean };
      }>();
      expect(body.data.length).toBe(2);
      expect(body.pagination.has_more).toBe(true);
      expect(body.pagination.cursor).not.toBeNull();
    });

    it('returns empty for date range with no recordings', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/recordings?start_date=2025-01-01T00:00:00.000Z&end_date=2025-01-01T23:59:59.000Z`,
        headers: { authorization: `Bearer ${orgAdminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: unknown[] }>();
      expect(body.data.length).toBe(0);
    });

    it('returns 400 without required date params', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/recordings`,
        headers: { authorization: `Bearer ${orgAdminToken}` },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/recordings?start_date=2026-05-10T00:00:00.000Z&end_date=2026-05-10T23:59:59.000Z`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/cameras/:cameraId/recordings/:recordingId', () => {
    it('returns recording with playback URL (200)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/recordings/${recordingId}`,
        headers: { authorization: `Bearer ${orgAdminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; playback_url: string; duration_seconds: number }>();
      expect(body.id).toBe(recordingId);
      expect(body.playback_url).toContain('https://');
      expect(body.duration_seconds).toBe(300);
    });

    it('returns 404 for non-existent recording', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/recordings/00000000-0000-0000-0000-000000000000`,
        headers: { authorization: `Bearer ${orgAdminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
