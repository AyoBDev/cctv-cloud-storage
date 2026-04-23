import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Inline Camera Assignment', () => {
  let app: FastifyInstance;
  let orgAdminAccessToken: string;
  let viewerId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'inline-assign');

    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create viewer
    const viewerEmail = `viewer-inline-${Date.now()}@example.com`;
    const viewerPassword = 'password123!';
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerId = viewerRes.json<{ id: string }>().id;
  }, 30000);

  afterAll(async () => {
    await closeTestApp();
  });

  it('creates a camera with inline viewer assignment', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: {
        name: 'Inline Assigned Camera',
        viewer_ids: [viewerId],
      },
    });

    expect(res.statusCode).toBe(201);
    const cameraId = res.json<{ id: string }>().id;

    // Verify assignment was created
    const viewersRes = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${cameraId}/viewers`,
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
    });

    expect(viewersRes.statusCode).toBe(200);
    const viewers = viewersRes.json<{ viewers: Array<{ id: string }> }>().viewers;
    expect(viewers).toHaveLength(1);
    expect(viewers[0]!.id).toBe(viewerId);
  });

  it('creates a camera without viewer_ids (no assignments)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'No Inline Camera' },
    });

    expect(res.statusCode).toBe(201);
    const cameraId = res.json<{ id: string }>().id;

    const viewersRes = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${cameraId}/viewers`,
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
    });

    expect(viewersRes.statusCode).toBe(200);
    expect(viewersRes.json<{ viewers: unknown[] }>().viewers).toHaveLength(0);
  });

  it('returns 400 for invalid viewer_ids', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: {
        name: 'Bad Viewer Camera',
        viewer_ids: ['00000000-0000-0000-0000-000000000000'],
      },
    });

    expect(res.statusCode).toBe(400);
  });
});
