import { buildTestApp, closeTestApp } from '../helpers/build-app';
import type { FastifyInstance } from 'fastify';

describe('Admin Organizations', () => {
  let app: FastifyInstance;
  let accessToken: string;

  beforeAll(async () => {
    app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: {
        email: process.env['SEED_ADMIN_EMAIL'] ?? 'admin@cctv-cloud.local',
        password: process.env['SEED_ADMIN_PASSWORD'] ?? 'changeme123!',
      },
    });
    const body = res.json<{ accessToken: string }>();
    accessToken = body.accessToken;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('GET /api/v1/admin/organizations', () => {
    it('returns 200 with paginated list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/organizations',
        headers: { authorization: `Bearer ${accessToken}` },
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
    });

    it('returns 401 without auth token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/organizations',
      });

      expect(res.statusCode).toBe(401);
    });

    it('respects page and limit query params', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/organizations?page=1&limit=5',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ pagination: { page: number; limit: number } }>();
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.limit).toBe(5);
    });
  });

  describe('POST /api/v1/admin/organizations', () => {
    it('creates an organization with admin user and returns 201', async () => {
      const slug = `test-org-${Date.now()}`;
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Test Organization',
          slug,
          adminEmail: `admin-${Date.now()}@example.com`,
          adminPassword: 'password123!',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; name: string; slug: string; is_active: boolean }>();
      expect(body).toHaveProperty('id');
      expect(body.name).toBe('Test Organization');
      expect(body.slug).toBe(slug);
      expect(body.is_active).toBe(true);
    });

    it('returns 409 on duplicate slug', async () => {
      const slug = `conflict-slug-${Date.now()}`;

      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'First Org',
          slug,
          adminEmail: `first-${Date.now()}@example.com`,
          adminPassword: 'password123!',
        },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Second Org',
          slug,
          adminEmail: `second-${Date.now()}@example.com`,
          adminPassword: 'password123!',
        },
      });
      expect(second.statusCode).toBe(409);
      const body = second.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('CONFLICT');
    });

    it('returns 409 on duplicate admin email', async () => {
      const email = `dup-email-${Date.now()}@example.com`;

      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Email Org 1',
          slug: `email-org-1-${Date.now()}`,
          adminEmail: email,
          adminPassword: 'password123!',
        },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Email Org 2',
          slug: `email-org-2-${Date.now()}`,
          adminEmail: email,
          adminPassword: 'password123!',
        },
      });
      expect(second.statusCode).toBe(409);
      const body = second.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('CONFLICT');
    });

    it('returns 400 on invalid slug format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Bad Slug Org',
          slug: 'Invalid Slug With Spaces!',
          adminEmail: `badslug-${Date.now()}@example.com`,
          adminPassword: 'password123!',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 on missing required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Incomplete Org' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without auth token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        payload: {
          name: 'Unauthorized Org',
          slug: `unauth-${Date.now()}`,
          adminEmail: `unauth-${Date.now()}@example.com`,
          adminPassword: 'password123!',
        },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/admin/organizations/:orgId', () => {
    let orgId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Get By ID Org',
          slug: `get-by-id-${Date.now()}`,
          adminEmail: `getbyid-${Date.now()}@example.com`,
          adminPassword: 'password123!',
        },
      });
      const body = res.json<{ id: string }>();
      orgId = body.id;
    });

    it('returns 200 with org object', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/organizations/${orgId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; name: string }>();
      expect(body.id).toBe(orgId);
      expect(body.name).toBe('Get By ID Org');
    });

    it('returns 404 for non-existent org', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/organizations/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(404);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 on invalid UUID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/organizations/not-a-uuid',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('PATCH /api/v1/admin/organizations/:orgId', () => {
    let orgId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Patch Test Org',
          slug: `patch-test-${Date.now()}`,
          adminEmail: `patchtest-${Date.now()}@example.com`,
          adminPassword: 'password123!',
        },
      });
      const body = res.json<{ id: string }>();
      orgId = body.id;
    });

    it('updates org name and returns 200', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/organizations/${orgId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Updated Org Name' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; name: string }>();
      expect(body.id).toBe(orgId);
      expect(body.name).toBe('Updated Org Name');
    });

    it('deactivates org and returns 200', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/organizations/${orgId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { is_active: false },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ is_active: boolean }>();
      expect(body.is_active).toBe(false);
    });

    it('returns 404 for non-existent org', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/organizations/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Ghost Org' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 on empty body', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/organizations/${orgId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/v1/admin/organizations/:orgId', () => {
    it('soft-deletes org and cascades to users, returns 204', async () => {
      // Create org with admin
      const email = `delete-cascade-${Date.now()}@example.com`;
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Delete Test Org',
          slug: `delete-test-${Date.now()}`,
          adminEmail: email,
          adminPassword: 'password123!',
        },
      });
      expect(createRes.statusCode).toBe(201);
      const { id: orgId } = createRes.json<{ id: string }>();

      // Delete the org
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/organizations/${orgId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(deleteRes.statusCode).toBe(204);

      // Verify org is soft-deleted (is_active = false)
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/organizations/${orgId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(getRes.statusCode).toBe(200);
      const orgBody = getRes.json<{ is_active: boolean }>();
      expect(orgBody.is_active).toBe(false);

      // Verify cascade: org users are deactivated
      const usersRes = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/users?orgId=${orgId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(usersRes.statusCode).toBe(200);
      const usersBody = usersRes.json<{ data: Array<{ is_active: boolean }> }>();
      for (const user of usersBody.data) {
        expect(user.is_active).toBe(false);
      }
    });

    it('returns 404 for non-existent org', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/organizations/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 401 without auth token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/organizations/00000000-0000-0000-0000-000000000000',
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
