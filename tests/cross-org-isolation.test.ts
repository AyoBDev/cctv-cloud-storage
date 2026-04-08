import { buildTestApp, closeTestApp } from './helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from './helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Cross-Org Isolation', () => {
  let app: FastifyInstance;
  let superAdminToken: string;

  // Org A
  let orgAAdminToken: string;
  let orgAViewerId: string;

  // Org B
  let orgBAdminToken: string;
  let orgBViewerId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);

    // Create Org A with admin + viewer
    const orgA = await createOrgAndLogin(app, superAdminToken, 'iso-a');
    orgAAdminToken = orgA.orgAdminAccessToken;

    const createViewerA = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAAdminToken}` },
      payload: { email: `viewer-a-${Date.now()}@example.com`, password: 'password123!' },
    });
    expect(createViewerA.statusCode).toBe(201);
    orgAViewerId = createViewerA.json<{ id: string }>().id;

    // Create Org B with admin + viewer
    const orgB = await createOrgAndLogin(app, superAdminToken, 'iso-b');
    orgBAdminToken = orgB.orgAdminAccessToken;

    const createViewerB = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgBAdminToken}` },
      payload: { email: `viewer-b-${Date.now()}@example.com`, password: 'password123!' },
    });
    expect(createViewerB.statusCode).toBe(201);
    orgBViewerId = createViewerB.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('Org A admin cannot access Org B resources', () => {
    it('GET /org/users/:userId — Org A admin gets 403 on Org B viewer', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/org/users/${orgBViewerId}`,
        headers: { authorization: `Bearer ${orgAAdminToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('PATCH /org/users/:userId — Org A admin gets 403 on Org B viewer', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/org/users/${orgBViewerId}`,
        headers: { authorization: `Bearer ${orgAAdminToken}` },
        payload: { is_active: false },
      });

      expect(res.statusCode).toBe(403);
    });

    it('DELETE /org/users/:userId — Org A admin gets 403 on Org B viewer', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/org/users/${orgBViewerId}`,
        headers: { authorization: `Bearer ${orgAAdminToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('Org B admin cannot access Org A resources', () => {
    it('GET /org/users/:userId — Org B admin gets 403 on Org A viewer', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/org/users/${orgAViewerId}`,
        headers: { authorization: `Bearer ${orgBAdminToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('PATCH /org/users/:userId — Org B admin gets 403 on Org A viewer', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/org/users/${orgAViewerId}`,
        headers: { authorization: `Bearer ${orgBAdminToken}` },
        payload: { is_active: false },
      });

      expect(res.statusCode).toBe(403);
    });

    it('DELETE /org/users/:userId — Org B admin gets 403 on Org A viewer', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/org/users/${orgAViewerId}`,
        headers: { authorization: `Bearer ${orgBAdminToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('List isolation', () => {
    it('Org A admin only sees Org A users in list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${orgAAdminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ id: string }> }>();
      const ids = body.data.map((u) => u.id);
      expect(ids).not.toContain(orgBViewerId);
    });

    it('Org B admin only sees Org B users in list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${orgBAdminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ id: string }> }>();
      const ids = body.data.map((u) => u.id);
      expect(ids).not.toContain(orgAViewerId);
    });
  });
});
