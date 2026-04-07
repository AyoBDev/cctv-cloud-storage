import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Cameras', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgId: string;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);

    const org = await createOrgAndLogin(app, superAdminToken, 'cameras');
    orgId = org.orgId;
    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create a viewer user and login
    const viewerEmail = `viewer-cam-${Date.now()}@example.com`;
    const viewerPassword = 'password123!';
    await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { email: viewerEmail, password: viewerPassword },
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerAccessToken = loginRes.json<{ accessToken: string }>().accessToken;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('POST /api/v1/cameras', () => {
    it('creates a camera and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: {
          name: 'Front Door Camera',
          location: 'Main Entrance',
          timezone: 'America/New_York',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{
        id: string;
        org_id: string;
        name: string;
        location: string;
        timezone: string;
        kvs_stream_name: string;
        status: string;
        is_active: boolean;
      }>();
      expect(body.name).toBe('Front Door Camera');
      expect(body.location).toBe('Main Entrance');
      expect(body.timezone).toBe('America/New_York');
      expect(body.org_id).toBe(orgId);
      expect(body.kvs_stream_name).toContain(orgId);
      expect(body.status).toBe('online');
      expect(body.is_active).toBe(true);
    });

    it('creates a camera with only name (minimum fields)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Minimal Camera' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ name: string; timezone: string; location: string | null }>();
      expect(body.name).toBe('Minimal Camera');
      expect(body.timezone).toBe('UTC');
      expect(body.location).toBeNull();
    });

    it('creates a camera with RTSP URL (encrypted at rest)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: {
          name: 'RTSP Camera',
          rtsp_url: 'rtsp://192.168.1.100:554/stream1',
        },
      });

      expect(res.statusCode).toBe(201);
      // Response should not contain rtsp_url (it's encrypted in DB, only returned on GET single)
      const body = res.json<Record<string, unknown>>();
      expect(body).not.toHaveProperty('rtsp_url');
      expect(body).not.toHaveProperty('rtsp_url_encrypted');
    });

    it('returns 400 on missing name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        payload: { name: 'No Auth Camera' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 for viewer (requireOrgAdmin)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { name: 'Viewer Camera' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('stores iot_thing_name in DB on creation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'IoT Thing Test Camera' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; kvs_stream_name: string }>();

      // Verify IoT fields in DB directly
      const dbRows = await app.db<
        Array<{ iot_thing_name: string | null; credentials_issued: boolean }>
      >`
        SELECT iot_thing_name, credentials_issued FROM cameras WHERE id = ${body.id}
      `;
      expect(dbRows[0]?.iot_thing_name).toBe(body.kvs_stream_name);
      expect(dbRows[0]?.credentials_issued).toBe(false);
    });
  });

  describe('GET /api/v1/cameras', () => {
    it('returns 200 with paginated list of cameras', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        data: unknown[];
        pagination: { page: number; limit: number; total: number };
      }>();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination).toHaveProperty('page');
      expect(body.pagination).toHaveProperty('limit');
      expect(body.pagination).toHaveProperty('total');
      expect(body.pagination.total).toBeGreaterThanOrEqual(1);
    });

    it('viewer can list cameras (requireUser)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras',
      });

      expect(res.statusCode).toBe(401);
    });

    it('serves cached response on second call', async () => {
      // First call populates cache
      const res1 = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
      expect(res1.statusCode).toBe(200);

      // Second call should hit cache
      const res2 = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
      expect(res2.statusCode).toBe(200);

      // Results should be identical
      expect(res1.json()).toEqual(res2.json());
    });

    it('does not include rtsp_url_encrypted in list response', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Record<string, unknown>[] }>();
      for (const camera of body.data) {
        expect(camera).not.toHaveProperty('rtsp_url_encrypted');
      }
    });
  });

  describe('GET /api/v1/cameras/:cameraId', () => {
    let cameraId: string;

    beforeAll(async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: {
          name: 'Get Test Camera',
          rtsp_url: 'rtsp://192.168.1.200:554/stream',
        },
      });
      cameraId = createRes.json<{ id: string }>().id;
    });

    it('returns 200 with camera details including decrypted RTSP URL', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        id: string;
        org_id: string;
        name: string;
        rtsp_url: string;
      }>();
      expect(body.id).toBe(cameraId);
      expect(body.org_id).toBe(orgId);
      expect(body.name).toBe('Get Test Camera');
      expect(body.rtsp_url).toBe('rtsp://192.168.1.200:554/stream');
    });

    it('viewer can get camera (requireUser)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 404 for non-existent camera', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 on invalid UUID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras/not-a-uuid',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('PATCH /api/v1/cameras/:cameraId', () => {
    let cameraId: string;

    beforeAll(async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Patch Test Camera' },
      });
      cameraId = createRes.json<{ id: string }>().id;
    });

    it('updates camera name and returns 200', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/cameras/${cameraId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Updated Camera Name' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ name: string }>();
      expect(body.name).toBe('Updated Camera Name');
    });

    it('updates camera location and timezone', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/cameras/${cameraId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { location: 'Lobby', timezone: 'Europe/London' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ location: string; timezone: string }>();
      expect(body.location).toBe('Lobby');
      expect(body.timezone).toBe('Europe/London');
    });

    it('updates RTSP URL (encrypted)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/cameras/${cameraId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { rtsp_url: 'rtsp://10.0.0.1:554/live' },
      });

      expect(res.statusCode).toBe(200);

      // Verify decrypted on GET
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
      expect(getRes.json<{ rtsp_url: string }>().rtsp_url).toBe('rtsp://10.0.0.1:554/live');
    });

    it('returns 400 on empty body', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/cameras/${cameraId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 403 for viewer', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/cameras/${cameraId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { name: 'Sneaky Update' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 404 for non-existent camera', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/cameras/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Ghost Camera' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('invalidates cache after update', async () => {
      // Populate cache
      await app.inject({
        method: 'GET',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      // Update a camera
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/cameras/${cameraId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Cache Buster' },
      });

      // List should reflect the update
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
      const body = listRes.json<{ data: Array<{ id: string; name: string }> }>();
      const camera = body.data.find((c) => c.id === cameraId);
      expect(camera?.name).toBe('Cache Buster');
    });
  });

  describe('DELETE /api/v1/cameras/:cameraId', () => {
    it('deactivates a camera and returns 204', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Delete Test Camera' },
      });
      expect(createRes.statusCode).toBe(201);
      const { id: camId } = createRes.json<{ id: string }>();

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/cameras/${camId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
      expect(deleteRes.statusCode).toBe(204);

      // Camera should be gone from active list
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${camId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
      expect(getRes.statusCode).toBe(404);
    });

    it('returns 403 for viewer', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Viewer Delete Test' },
      });
      const { id: camId } = createRes.json<{ id: string }>();

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/cameras/${camId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 404 for non-existent camera', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/cameras/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/cameras/00000000-0000-0000-0000-000000000000',
      });

      expect(res.statusCode).toBe(401);
    });

    it('clears camera status on deactivation (IoT cleanup skipped in test)', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'IoT Delete Test Camera' },
      });
      const { id: camId } = createRes.json<{ id: string }>();

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/cameras/${camId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
      expect(deleteRes.statusCode).toBe(204);

      // Verify camera is inactive in DB
      const dbRows = await app.db<Array<{ status: string; is_active: boolean }>>`
        SELECT status, is_active FROM cameras WHERE id = ${camId}
      `;
      expect(dbRows[0]?.status).toBe('inactive');
      expect(dbRows[0]?.is_active).toBe(false);
    });
  });

  describe('GET /api/v1/admin/cameras (Super Admin)', () => {
    it('returns 200 with all cameras cross-org', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/cameras',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        data: unknown[];
        pagination: { page: number; limit: number; total: number };
      }>();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination.total).toBeGreaterThanOrEqual(1);
    });

    it('filters by org_id query parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/cameras?org_id=${orgId}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ org_id: string }> }>();
      for (const camera of body.data) {
        expect(camera.org_id).toBe(orgId);
      }
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/cameras',
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 for org admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
