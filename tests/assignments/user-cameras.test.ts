import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('User Camera Assignments', () => {
  let app: FastifyInstance;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let viewerId: string;
  let cameraId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'user-cameras');

    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create viewer
    const viewerEmail = `viewer-uc-${Date.now()}@example.com`;
    const viewerPassword = 'password123!';
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerId = viewerRes.json<{ id: string }>().id;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerAccessToken = loginRes.json<{ accessToken: string }>().accessToken;

    // Create camera
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'User Route Camera' },
    });
    cameraId = camRes.json<{ id: string }>().id;
  }, 30000);

  afterAll(async () => {
    await closeTestApp();
  });

  describe('POST /api/v1/org/users/:userId/cameras', () => {
    it('adds cameras to a viewer (org admin)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/org/users/${viewerId}/cameras`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { camera_ids: [cameraId] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ assigned: number }>().assigned).toBe(1);
    });

    it('returns 403 for viewer', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/org/users/${viewerId}/cameras`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { camera_ids: [cameraId] },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 400 for invalid camera IDs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/org/users/${viewerId}/cameras`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { camera_ids: ['00000000-0000-0000-0000-000000000000'] },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/org/users/:userId/cameras', () => {
    it('lists cameras assigned to a viewer', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/org/users/${viewerId}/cameras`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ cameras: Array<{ id: string; name: string; slug: string; status: string; assigned_at: string }> }>();
      expect(body.cameras).toHaveLength(1);
      expect(body.cameras[0]!.id).toBe(cameraId);
    });
  });

  describe('PUT /api/v1/org/users/:userId/cameras', () => {
    it('replaces all cameras for a viewer', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/org/users/${viewerId}/cameras`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { camera_ids: [cameraId] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ assigned: number }>().assigned).toBe(1);
    });
  });

  describe('DELETE /api/v1/org/users/:userId/cameras', () => {
    it('removes cameras from a viewer', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/org/users/${viewerId}/cameras`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { camera_ids: [cameraId] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ removed: number }>().removed).toBe(1);
    });

    it('confirms camera list is empty after removal', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/org/users/${viewerId}/cameras`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ cameras: unknown[] }>().cameras).toHaveLength(0);
    });
  });
});
