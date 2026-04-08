import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Org Auth', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgAdminEmail: string;
  let orgAdminPassword: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);

    const org = await createOrgAndLogin(app, superAdminToken, 'auth');
    orgAdminEmail = org.orgAdminEmail;
    orgAdminPassword = org.orgAdminPassword;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('POST /api/v1/auth/login', () => {
    it('returns 200 with token pair for org_admin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: orgAdminEmail,
          password: orgAdminPassword,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ accessToken: string; refreshToken: string }>();
      expect(body).toHaveProperty('accessToken');
      expect(body).toHaveProperty('refreshToken');
    });

    it('returns 401 on wrong password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: orgAdminEmail,
          password: 'wrongpassword123',
        },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('returns 401 on non-existent user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'nobody@example.com',
          password: 'somepassword123',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 401 for super_admin trying to use org login', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: process.env['SEED_ADMIN_EMAIL'] ?? 'admin@cctv-cloud.local',
          password: process.env['SEED_ADMIN_PASSWORD'] ?? 'changeme123!',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when org is deactivated', async () => {
      // Create a fresh org, deactivate it, then try to login
      const ts = Date.now();
      const email = `deact-org-admin-${ts}@example.com`;

      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/organizations',
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: {
          name: 'Deact Org',
          slug: `deact-org-${ts}`,
          adminEmail: email,
          adminPassword: 'password123!',
        },
      });
      expect(createRes.statusCode).toBe(201);
      const { id: orgId } = createRes.json<{ id: string }>();

      // Deactivate the org
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/organizations/${orgId}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { is_active: false },
      });
      expect(patchRes.statusCode).toBe(200);

      // Try to login
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'password123!' },
      });

      expect(loginRes.statusCode).toBe(403);
    });

    it('returns 400 on invalid email format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'not-an-email',
          password: 'somepassword123',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 on missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    let freshRefreshToken: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: orgAdminEmail, password: orgAdminPassword },
      });
      const body = res.json<{ refreshToken: string }>();
      freshRefreshToken = body.refreshToken;
    });

    it('returns 200 with new token pair', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: freshRefreshToken },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ accessToken: string; refreshToken: string }>();
      expect(body).toHaveProperty('accessToken');
      expect(body).toHaveProperty('refreshToken');
      expect(body.refreshToken).not.toBe(freshRefreshToken);
    });

    it('returns 401 on invalid token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: 'not.a.valid.token' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    let logoutAccessToken: string;
    let logoutRefreshToken: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: orgAdminEmail, password: orgAdminPassword },
      });
      const body = res.json<{ accessToken: string; refreshToken: string }>();
      logoutAccessToken = body.accessToken;
      logoutRefreshToken = body.refreshToken;
    });

    it('returns 204 on successful logout', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { authorization: `Bearer ${logoutAccessToken}` },
        payload: { refreshToken: logoutRefreshToken },
      });

      expect(res.statusCode).toBe(204);
    });

    it('refresh token is revoked after logout', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: logoutRefreshToken },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 401 without authorization header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        payload: { refreshToken: 'sometoken' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 for super_admin token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { refreshToken: 'sometoken' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /api/v1/auth/change-password', () => {
    let cpAccessToken: string;
    const newPassword = 'newpassword123!';

    beforeAll(async () => {
      // Use a fresh login for change-password tests
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: orgAdminEmail, password: orgAdminPassword },
      });
      const body = res.json<{ accessToken: string }>();
      cpAccessToken = body.accessToken;
    });

    it('returns 200 on successful password change', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: { authorization: `Bearer ${cpAccessToken}` },
        payload: {
          currentPassword: orgAdminPassword,
          newPassword,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ message: string }>();
      expect(body.message).toBe('Password changed successfully');
    });

    it('can login with new password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: orgAdminEmail, password: newPassword },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 401 with old password', async () => {
      // Get a fresh token with new password
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: orgAdminEmail, password: newPassword },
      });
      const { accessToken } = loginRes.json<{ accessToken: string }>();

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          currentPassword: orgAdminPassword,
          newPassword: 'anotherpassword1!',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 401 without authorization header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        payload: {
          currentPassword: 'whatever123!',
          newPassword: 'newpass12345!',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 400 on missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: { authorization: `Bearer ${cpAccessToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
