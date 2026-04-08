import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Cross-Org Camera Isolation', () => {
  let app: FastifyInstance;
  let superAdminToken: string;

  // Org A
  let orgAAdminToken: string;
  let orgACameraId: string;

  // Org B
  let orgBAdminToken: string;
  let orgBCameraId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);

    // Create Org A with camera
    const orgA = await createOrgAndLogin(app, superAdminToken, 'cam-iso-a');
    orgAAdminToken = orgA.orgAdminAccessToken;

    const camARes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAAdminToken}` },
      payload: { name: 'Org A Camera' },
    });
    expect(camARes.statusCode).toBe(201);
    orgACameraId = camARes.json<{ id: string }>().id;

    // Create Org B with camera
    const orgB = await createOrgAndLogin(app, superAdminToken, 'cam-iso-b');
    orgBAdminToken = orgB.orgAdminAccessToken;

    const camBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgBAdminToken}` },
      payload: { name: 'Org B Camera' },
    });
    expect(camBRes.statusCode).toBe(201);
    orgBCameraId = camBRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('Org A admin cannot access Org B cameras', () => {
    it('GET /cameras/:cameraId — Org A admin gets 403 on Org B camera', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${orgBCameraId}`,
        headers: { authorization: `Bearer ${orgAAdminToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('PATCH /cameras/:cameraId — Org A admin gets 403 on Org B camera', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/cameras/${orgBCameraId}`,
        headers: { authorization: `Bearer ${orgAAdminToken}` },
        payload: { name: 'Hijacked Camera' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('DELETE /cameras/:cameraId — Org A admin gets 403 on Org B camera', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/cameras/${orgBCameraId}`,
        headers: { authorization: `Bearer ${orgAAdminToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('Org B admin cannot access Org A cameras', () => {
    it('GET /cameras/:cameraId — Org B admin gets 403 on Org A camera', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${orgACameraId}`,
        headers: { authorization: `Bearer ${orgBAdminToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('PATCH /cameras/:cameraId — Org B admin gets 403 on Org A camera', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/cameras/${orgACameraId}`,
        headers: { authorization: `Bearer ${orgBAdminToken}` },
        payload: { name: 'Hijacked Camera' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('DELETE /cameras/:cameraId — Org B admin gets 403 on Org A camera', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/cameras/${orgACameraId}`,
        headers: { authorization: `Bearer ${orgBAdminToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('List isolation', () => {
    it('Org A admin only sees Org A cameras in list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAAdminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ id: string }> }>();
      const ids = body.data.map((c) => c.id);
      expect(ids).toContain(orgACameraId);
      expect(ids).not.toContain(orgBCameraId);
    });

    it('Org B admin only sees Org B cameras in list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgBAdminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ id: string }> }>();
      const ids = body.data.map((c) => c.id);
      expect(ids).toContain(orgBCameraId);
      expect(ids).not.toContain(orgACameraId);
    });
  });
});
