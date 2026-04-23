import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Viewer Access Filtering', () => {
  let app: FastifyInstance;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let viewerId: string;
  let assignedCameraId: string;
  let unassignedCameraId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'viewer-access');

    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create viewer
    const viewerEmail = `viewer-va-${Date.now()}@example.com`;
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

    // Create two cameras
    const cam1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Assigned Camera' },
    });
    assignedCameraId = cam1Res.json<{ id: string }>().id;

    const cam2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Unassigned Camera' },
    });
    unassignedCameraId = cam2Res.json<{ id: string }>().id;

    // Assign only the first camera to the viewer
    await app.inject({
      method: 'POST',
      url: `/api/v1/cameras/${assignedCameraId}/viewers`,
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { user_ids: [viewerId] },
    });
  }, 30000);

  afterAll(async () => {
    await closeTestApp();
  });

  describe('GET /api/v1/cameras (list)', () => {
    it('viewer sees only assigned cameras', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ id: string }>; pagination: { total: number } }>();
      expect(body.pagination.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.id).toBe(assignedCameraId);
    });

    it('org admin sees all cameras', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ id: string }>; pagination: { total: number } }>();
      expect(body.pagination.total).toBeGreaterThanOrEqual(2);
    });
  });

  describe('GET /api/v1/cameras/:cameraId (detail)', () => {
    it('viewer can access assigned camera', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${assignedCameraId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it('viewer gets 403 on unassigned camera', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${unassignedCameraId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('org admin can access any camera', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${unassignedCameraId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/cameras/:cameraId/credentials', () => {
    it('viewer gets 403 on unassigned camera credentials', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${unassignedCameraId}/credentials`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
