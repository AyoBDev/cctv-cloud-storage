import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Org Users', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgId: string;
  let orgAdminAccessToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);

    const org = await createOrgAndLogin(app, superAdminToken, 'org-users');
    orgId = org.orgId;
    orgAdminAccessToken = org.orgAdminAccessToken;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('GET /api/v1/org/users', () => {
    it('returns 200 with paginated list of org users', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/org/users',
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
      // Should have at least the org_admin user
      expect(body.pagination.total).toBeGreaterThanOrEqual(1);
    });

    it('does not include password_hash', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Record<string, unknown>[] }>();
      for (const user of body.data) {
        expect(user).not.toHaveProperty('password_hash');
      }
    });

    it('returns 401 without auth token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/org/users',
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 for super_admin token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /api/v1/org/users', () => {
    it('creates a viewer user and returns 201', async () => {
      const email = `viewer-${Date.now()}@example.com`;
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { email, password: 'password123!' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{
        id: string;
        email: string;
        role: string;
        org_id: string;
        is_active: boolean;
      }>();
      expect(body.email).toBe(email);
      expect(body.role).toBe('viewer');
      expect(body.org_id).toBe(orgId);
      expect(body.is_active).toBe(true);
    });

    it('returns 409 on duplicate email', async () => {
      const email = `dup-viewer-${Date.now()}@example.com`;

      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { email, password: 'password123!' },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { email, password: 'password123!' },
      });
      expect(second.statusCode).toBe(409);
      const body = second.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('CONFLICT');
    });

    it('returns 400 on invalid email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { email: 'not-an-email', password: 'password123!' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 on missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/org/users',
        payload: { email: 'test@example.com', password: 'password123!' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/org/users/:userId', () => {
    let viewerUserId: string;

    beforeAll(async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { email: `get-viewer-${Date.now()}@example.com`, password: 'password123!' },
      });
      const body = createRes.json<{ id: string }>();
      viewerUserId = body.id;
    });

    it('returns 200 with user details', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/org/users/${viewerUserId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; email: string; role: string; org_id: string }>();
      expect(body.id).toBe(viewerUserId);
      expect(body.org_id).toBe(orgId);
    });

    it('returns 404 for non-existent user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/org/users/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 on invalid UUID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/org/users/not-a-uuid',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('PATCH /api/v1/org/users/:userId', () => {
    let viewerUserId: string;

    beforeAll(async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { email: `patch-viewer-${Date.now()}@example.com`, password: 'password123!' },
      });
      const body = createRes.json<{ id: string }>();
      viewerUserId = body.id;
    });

    it('deactivates a user and returns 200', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/org/users/${viewerUserId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { is_active: false },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ is_active: boolean }>();
      expect(body.is_active).toBe(false);
    });

    it('reactivates a user and returns 200', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/org/users/${viewerUserId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { is_active: true },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ is_active: boolean }>();
      expect(body.is_active).toBe(true);
    });

    it('returns 404 for non-existent user', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/org/users/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { is_active: false },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 on missing is_active', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/org/users/${viewerUserId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/v1/org/users/:userId', () => {
    it('deletes a viewer and returns 204', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { email: `delete-viewer-${Date.now()}@example.com`, password: 'password123!' },
      });
      expect(createRes.statusCode).toBe(201);
      const { id: viewerId } = createRes.json<{ id: string }>();

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/org/users/${viewerId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
      expect(deleteRes.statusCode).toBe(204);

      // Verify user is gone
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/org/users/${viewerId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
      expect(getRes.statusCode).toBe(404);
    });

    it('returns 403 when trying to delete org_admin', async () => {
      // Get the org_admin user id
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
      const listBody = listRes.json<{ data: Array<{ id: string; role: string }> }>();
      const orgAdmin = listBody.data.find((u) => u.role === 'org_admin');
      if (!orgAdmin) throw new Error('No org_admin found');

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/org/users/${orgAdmin.id}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('returns 404 for non-existent user', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/org/users/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/org/users/00000000-0000-0000-0000-000000000000',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('Viewer auth restrictions', () => {
    let viewerAccessToken: string;

    beforeAll(async () => {
      const email = `viewer-auth-${Date.now()}@example.com`;
      const password = 'password123!';

      // Create a viewer
      await app.inject({
        method: 'POST',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { email, password },
      });

      // Login as the viewer
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password },
      });
      expect(loginRes.statusCode).toBe(200);
      const body = loginRes.json<{ accessToken: string }>();
      viewerAccessToken = body.accessToken;
    });

    it('viewer cannot list org users (403)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('viewer cannot create org users (403)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { email: 'test@example.com', password: 'password123!' },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
