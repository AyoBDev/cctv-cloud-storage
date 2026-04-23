import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Cross-Org Assignment Isolation', () => {
  let app: FastifyInstance;
  let orgAAdminToken: string;
  let orgBAdminToken: string;
  let orgAViewerId: string;
  let orgACameraId: string;
  let orgBCameraId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);

    const orgA = await createOrgAndLogin(app, superAdminToken, 'iso-a');
    orgAAdminToken = orgA.orgAdminAccessToken;

    const orgB = await createOrgAndLogin(app, superAdminToken, 'iso-b');
    orgBAdminToken = orgB.orgAdminAccessToken;

    // Create viewer in Org A
    const viewerEmail = `viewer-iso-${Date.now()}@example.com`;
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAAdminToken}` },
      payload: { email: viewerEmail, password: 'password123!' },
    });
    orgAViewerId = viewerRes.json<{ id: string }>().id;

    // Create camera in Org A
    const camARes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAAdminToken}` },
      payload: { name: 'Org A Camera' },
    });
    orgACameraId = camARes.json<{ id: string }>().id;

    // Create camera in Org B
    const camBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgBAdminToken}` },
      payload: { name: 'Org B Camera' },
    });
    orgBCameraId = camBRes.json<{ id: string }>().id;
  }, 30000);

  afterAll(async () => {
    await closeTestApp();
  });

  it('cannot assign Org B camera to Org A viewer via camera-centric endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cameras/${orgBCameraId}/viewers`,
      headers: { authorization: `Bearer ${orgAAdminToken}` },
      payload: { user_ids: [orgAViewerId] },
    });

    // Should fail — camera belongs to Org B, not Org A
    expect(res.statusCode).toBe(404);
  });

  it('cannot assign Org B camera to Org A viewer via user-centric endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/org/users/${orgAViewerId}/cameras`,
      headers: { authorization: `Bearer ${orgAAdminToken}` },
      payload: { camera_ids: [orgBCameraId] },
    });

    // Should fail — camera belongs to Org B
    expect(res.statusCode).toBe(400);
  });

  it('Org B admin cannot assign Org A viewer to Org B camera', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cameras/${orgBCameraId}/viewers`,
      headers: { authorization: `Bearer ${orgBAdminToken}` },
      payload: { user_ids: [orgAViewerId] },
    });

    // Should fail — viewer belongs to Org A, not Org B
    expect(res.statusCode).toBe(400);
  });

  it('Org B admin cannot list viewers for Org A camera', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${orgACameraId}/viewers`,
      headers: { authorization: `Bearer ${orgBAdminToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
