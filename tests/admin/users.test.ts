import { buildTestApp, closeTestApp } from '../helpers/build-app';
import type { FastifyInstance } from 'fastify';

describe('Admin Users', () => {
  let app: FastifyInstance;
  let accessToken: string;
  let orgId: string;

  beforeAll(async () => {
    app = await buildTestApp();

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: {
        email: process.env['SEED_ADMIN_EMAIL'] ?? 'admin@cctv-cloud.local',
        password: process.env['SEED_ADMIN_PASSWORD'] ?? 'changeme123!',
      },
    });
    const loginBody = loginRes.json<{ accessToken: string }>();
    accessToken = loginBody.accessToken;

    // Create a test org for user tests
    const orgRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/organizations',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: 'Users Test Org',
        slug: `users-test-org-${Date.now()}`,
        adminEmail: `users-org-admin-${Date.now()}@example.com`,
        adminPassword: 'password123!',
      },
    });
    const orgBody = orgRes.json<{ id: string }>();
    orgId = orgBody.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('GET /api/v1/admin/users', () => {
    it('returns 200 with paginated list of all users', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/users',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        data: unknown[];
        pagination: { page: number; limit: number; total: number };
      }>();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination.total).toBeGreaterThan(0);
    });

    it('filters by orgId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/users?orgId=${orgId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ org_id: string }> }>();
      for (const user of body.data) {
        expect(user.org_id).toBe(orgId);
      }
    });

    it('never includes password_hash in response', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/users',
        headers: { authorization: `Bearer ${accessToken}` },
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
        url: '/api/v1/admin/users',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/admin/users/:userId', () => {
    let userId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/users?orgId=${orgId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const body = res.json<{ data: Array<{ id: string }> }>();
      const firstUser = body.data[0];
      if (!firstUser) throw new Error('No users found for org');
      userId = firstUser.id;
    });

    it('returns 200 with user object (no password_hash)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/users/${userId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<Record<string, unknown>>();
      expect(body).toHaveProperty('id', userId);
      expect(body).toHaveProperty('email');
      expect(body).toHaveProperty('role');
      expect(body).not.toHaveProperty('password_hash');
    });

    it('returns 404 for non-existent user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/users/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(404);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 on invalid UUID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/users/not-a-uuid',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('PATCH /api/v1/admin/users/:userId', () => {
    let userId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/users?orgId=${orgId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const body = res.json<{ data: Array<{ id: string }> }>();
      const firstUser = body.data[0];
      if (!firstUser) throw new Error('No users found for org');
      userId = firstUser.id;
    });

    it('deactivates a user and returns 200', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/users/${userId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { is_active: false },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ is_active: boolean }>();
      expect(body.is_active).toBe(false);
    });

    it('reactivates a user and returns 200', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/users/${userId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { is_active: true },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ is_active: boolean }>();
      expect(body.is_active).toBe(true);
    });

    it('returns 404 for non-existent user', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/users/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { is_active: false },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 on missing is_active field', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/users/${userId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/v1/admin/users/:userId', () => {
    it('deletes an org user and returns 204, then 404 on subsequent GET', async () => {
      // Create a fresh org with an admin to delete
      const createOrgRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Delete User Org',
          slug: `delete-user-org-${Date.now()}`,
          adminEmail: `delete-user-${Date.now()}@example.com`,
          adminPassword: 'password123!',
        },
      });
      expect(createOrgRes.statusCode).toBe(201);
      const { id: newOrgId } = createOrgRes.json<{ id: string }>();

      // Get the created user
      const usersRes = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/users?orgId=${newOrgId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const usersBody = usersRes.json<{ data: Array<{ id: string }> }>();
      const userToDelete = usersBody.data[0];
      if (!userToDelete) throw new Error('No user found for org');

      // Delete the user
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/users/${userToDelete.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(deleteRes.statusCode).toBe(204);

      // Verify user is gone
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/users/${userToDelete.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(getRes.statusCode).toBe(404);
    });

    it('returns 403 when trying to delete a super_admin', async () => {
      // Decode the access token to get the super_admin user id
      const payload = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64').toString()) as {
        sub: string;
      };

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/users/${payload.sub}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('returns 404 for non-existent user', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/users/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 401 without auth token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/users/00000000-0000-0000-0000-000000000000',
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
