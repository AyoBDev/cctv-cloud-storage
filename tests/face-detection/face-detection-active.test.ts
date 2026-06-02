import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Internal Face Detection Active', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgAdminAccessToken: string;
  let cameraId: string;
  const internalSecret = process.env['INTERNAL_API_SECRET'] ?? 'test-internal-secret-1234567890';

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'face-det-active');
    orgAdminAccessToken = org.orgAdminAccessToken;

    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Active Check Camera' },
    });
    cameraId = camRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('GET /internal/cameras/:cameraId/face-detection-active', () => {
    it('returns active: true with default settings', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/cameras/${cameraId}/face-detection-active`,
        headers: { 'x-internal-secret': internalSecret },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.active).toBe(true);
    });

    it('returns active: false when camera disabled', async () => {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/cameras/${cameraId}/face-detection`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { enabled: false },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/internal/cameras/${cameraId}/face-detection-active`,
        headers: { 'x-internal-secret': internalSecret },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().active).toBe(false);
    });

    it('returns active: false when org disabled and camera inherits', async () => {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/cameras/${cameraId}/face-detection`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { enabled: null },
      });

      await app.inject({
        method: 'PATCH',
        url: '/api/v1/org/face-detection',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { enabled: false },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/internal/cameras/${cameraId}/face-detection-active`,
        headers: { 'x-internal-secret': internalSecret },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().active).toBe(false);

      // Re-enable org for other tests
      await app.inject({
        method: 'PATCH',
        url: '/api/v1/org/face-detection',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { enabled: true },
      });
    });

    it('returns 401 without internal secret', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/cameras/${cameraId}/face-detection-active`,
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns active: false for non-existent camera', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/cameras/00000000-0000-0000-0000-000000000000/face-detection-active',
        headers: { 'x-internal-secret': internalSecret },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().active).toBe(false);
    });
  });
});
