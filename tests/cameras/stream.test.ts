import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Camera Stream - GET /api/v1/cameras/:cameraId/stream', () => {
  let app: FastifyInstance;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let viewerId: string;
  let cameraId: string;
  let kvsStreamName: string;
  const internalSecret = process.env['INTERNAL_API_SECRET'] ?? 'test-secret-minimum-16-chars-long';

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'stream');
    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create a viewer user
    const viewerEmail = `viewer-stream-${Date.now()}@example.com`;
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

    // Create a camera with the viewer assigned
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Stream Test Camera', viewer_ids: [viewerId] },
    });
    expect(camRes.statusCode).toBe(201);
    const camBody = camRes.json<{ id: string; kvs_stream_name: string }>();
    cameraId = camBody.id;
    kvsStreamName = camBody.kvs_stream_name;

    // Set camera to online via internal webhook
    const statusRes = await app.inject({
      method: 'POST',
      url: '/internal/cameras/status',
      headers: { 'x-internal-secret': internalSecret },
      payload: { kvs_stream_name: kvsStreamName, status: 'online' },
    });
    expect(statusRes.statusCode).toBe(200);
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('returns HLS URL for org_admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${cameraId}/stream`,
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ hls_url: string; expires_in: number }>();
    expect(body.hls_url).toContain('mock-kvs.amazonaws.com');
    expect(body.hls_url).toContain(kvsStreamName);
    expect(body.expires_in).toBe(900);
  });

  it('returns HLS URL for assigned viewer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${cameraId}/stream`,
      headers: { authorization: `Bearer ${viewerAccessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ hls_url: string; expires_in: number }>();
    expect(body.hls_url).toContain('mock-kvs.amazonaws.com');
    expect(body.expires_in).toBe(900);
  });

  it('returns 403 for unassigned viewer', async () => {
    // Create another camera without assigning the viewer
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Unassigned Camera' },
    });
    const unassignedCameraId = camRes.json<{ id: string }>().id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${unassignedCameraId}/stream`,
      headers: { authorization: `Bearer ${viewerAccessToken}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${cameraId}/stream`,
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for non-existent camera', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${fakeId}/stream`,
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when camera is not online', async () => {
    // Create a new camera (status will be 'provisioning')
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Offline Camera' },
    });
    const offlineCameraId = camRes.json<{ id: string }>().id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${offlineCameraId}/stream`,
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.message).toContain('not online');
  });
});
