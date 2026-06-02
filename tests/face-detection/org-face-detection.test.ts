import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Org Face Detection', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgAdminAccessToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'face-det-org');
    orgAdminAccessToken = org.orgAdminAccessToken;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('GET /api/v1/org/face-detection', () => {
    it('returns default settings (enabled, no schedule)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/org/face-detection',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.enabled).toBe(true);
      expect(body.schedule).toBeNull();
      expect(body.duration_until).toBeNull();
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/org/face-detection',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('PATCH /api/v1/org/face-detection', () => {
    it('disables face detection', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/org/face-detection',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { enabled: false },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.enabled).toBe(false);
      expect(body.schedule).toBeNull();
      expect(body.duration_until).toBeNull();
    });

    it('enables with schedule', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/org/face-detection',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: {
          enabled: true,
          schedule: { start_time: '18:00', end_time: '06:00' },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.enabled).toBe(true);
      expect(body.schedule).toEqual({ start_time: '18:00', end_time: '06:00' });
    });

    it('enables with duration', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/org/face-detection',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: {
          enabled: true,
          duration_minutes: 120,
          schedule: null,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.enabled).toBe(true);
      expect(body.duration_until).toBeTruthy();
      expect(body.schedule).toBeNull();
    });

    it('returns 400 when both duration and schedule provided', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/org/face-detection',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: {
          enabled: true,
          duration_minutes: 120,
          schedule: { start_time: '18:00', end_time: '06:00' },
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('clears schedule with null', async () => {
      await app.inject({
        method: 'PATCH',
        url: '/api/v1/org/face-detection',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { enabled: true, schedule: { start_time: '20:00', end_time: '08:00' } },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/org/face-detection',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { schedule: null },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.schedule).toBeNull();
    });
  });
});
