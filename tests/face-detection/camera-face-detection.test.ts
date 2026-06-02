import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Camera Face Detection', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgAdminAccessToken: string;
  let cameraId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'face-det-cam');
    orgAdminAccessToken = org.orgAdminAccessToken;

    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Face Det Test Camera' },
    });
    cameraId = camRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('GET /api/v1/cameras/:cameraId/face-detection', () => {
    it('returns inherited org settings when no camera override', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/face-detection`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.camera_override.enabled).toBeNull();
      expect(body.effective.enabled).toBe(true);
      expect(body.effective.active_now).toBe(true);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/face-detection`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('PATCH /api/v1/cameras/:cameraId/face-detection', () => {
    it('sets camera override to disabled', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/cameras/${cameraId}/face-detection`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { enabled: false },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.camera_override.enabled).toBe(false);
      expect(body.effective.enabled).toBe(false);
      expect(body.effective.active_now).toBe(false);
    });

    it('sets camera override with schedule', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/cameras/${cameraId}/face-detection`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: {
          enabled: true,
          schedule: { start_time: '00:00', end_time: '23:59' },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.camera_override.enabled).toBe(true);
      expect(body.camera_override.schedule).toEqual({ start_time: '00:00', end_time: '23:59' });
      expect(body.effective.active_now).toBe(true);
    });

    it('clears override with enabled: null', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/cameras/${cameraId}/face-detection`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { enabled: null },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.camera_override.enabled).toBeNull();
      expect(body.camera_override.schedule).toBeNull();
    });

    it('returns 400 when both duration and schedule provided', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/cameras/${cameraId}/face-detection`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: {
          enabled: true,
          duration_minutes: 60,
          schedule: { start_time: '18:00', end_time: '06:00' },
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 403 for wrong org', async () => {
      const org2 = await createOrgAndLogin(app, superAdminToken, 'face-det-cam-org2');

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/face-detection`,
        headers: { authorization: `Bearer ${org2.orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
