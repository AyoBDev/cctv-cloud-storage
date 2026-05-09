import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Face Profiles', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let createdProfileId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);

    const org = await createOrgAndLogin(app, superAdminToken, 'face-profiles');
    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create a viewer user and login
    const viewerEmail = `viewer-fp-${Date.now()}@example.com`;
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

  describe('POST /api/v1/face-profiles', () => {
    it('creates a face profile and returns 201 (org admin)', async () => {
      const form = new FormData();
      form.append('label', 'John Smith');
      form.append('image', new Blob([Buffer.alloc(100)], { type: 'image/jpeg' }), 'face.jpg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/face-profiles',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: form,
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; label: string; face_id: string; image_url: string }>();
      expect(body.label).toBe('John Smith');
      expect(body.face_id).toMatch(/^mock-face-id-/);
      expect(body.image_url).toContain('face-profiles');
      createdProfileId = body.id;
    });

    it('creates a face profile as viewer (201)', async () => {
      const form = new FormData();
      form.append('label', 'Jane Doe');
      form.append('image', new Blob([Buffer.alloc(100)], { type: 'image/jpeg' }), 'face.jpg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/face-profiles',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: form,
      });

      expect(res.statusCode).toBe(201);
    });

    it('returns 401 without token', async () => {
      const form = new FormData();
      form.append('label', 'Test');
      form.append('image', new Blob([Buffer.alloc(100)], { type: 'image/jpeg' }), 'face.jpg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/face-profiles',
        payload: form,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/face-profiles', () => {
    it('lists face profiles (200)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/face-profiles',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: unknown[]; pagination: { page: number; limit: number; total: number } }>();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.pagination.page).toBe(1);
    });

    it('viewer can list face profiles (200)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/face-profiles',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/face-profiles/:id', () => {
    it('returns a single profile (200)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/face-profiles/${createdProfileId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; label: string; image_url: string }>();
      expect(body.id).toBe(createdProfileId);
      expect(body.image_url).toBeDefined();
    });

    it('returns 404 for non-existent id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/face-profiles/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/v1/face-profiles/:id', () => {
    it('returns 403 when viewer tries to delete', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/face-profiles/${createdProfileId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('deletes the face profile (204)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/face-profiles/${createdProfileId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(204);
    });

    it('returns 404 after deletion', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/face-profiles/${createdProfileId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
