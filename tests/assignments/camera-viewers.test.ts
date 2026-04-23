import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Camera Viewer Assignments', () => {
  let app: FastifyInstance;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let viewerId: string;
  let cameraId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'cam-viewers');

    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create viewer
    const viewerEmail = `viewer-cv-${Date.now()}@example.com`;
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
      payload: { name: 'Viewer Route Camera' },
    });
    cameraId = camRes.json<{ id: string }>().id;
  }, 30000);

  afterAll(async () => {
    await closeTestApp();
  });

  describe('POST /api/v1/cameras/:cameraId/viewers', () => {
    it('adds viewers to a camera (org admin)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { user_ids: [viewerId] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ assigned: number }>();
      expect(body.assigned).toBe(1);
    });

    it('returns 403 for viewer', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { user_ids: [viewerId] },
      });

      expect(res.statusCode).toBe(403);
    });

    it('is idempotent', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { user_ids: [viewerId] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ assigned: number }>().assigned).toBe(0);
    });

    it('returns 400 for invalid user IDs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { user_ids: ['00000000-0000-0000-0000-000000000000'] },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/cameras/:cameraId/viewers', () => {
    it('lists viewers assigned to a camera', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ viewers: Array<{ id: string; email: string; assigned_at: string }> }>();
      expect(body.viewers).toHaveLength(1);
      expect(body.viewers[0]!.id).toBe(viewerId);
    });
  });

  describe('PUT /api/v1/cameras/:cameraId/viewers', () => {
    it('replaces all viewers for a camera', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { user_ids: [viewerId] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ assigned: number }>().assigned).toBe(1);
    });
  });

  describe('DELETE /api/v1/cameras/:cameraId/viewers', () => {
    it('removes viewers from a camera', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { user_ids: [viewerId] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ removed: number }>().removed).toBe(1);
    });

    it('confirms viewer list is empty after removal', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ viewers: unknown[] }>().viewers).toHaveLength(0);
    });
  });
});
