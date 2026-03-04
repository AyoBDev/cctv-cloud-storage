import { buildTestApp, closeTestApp } from '../helpers/build-app';
import type { FastifyInstance } from 'fastify';

describe('Admin Auth', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('POST /api/v1/admin/auth/login', () => {
    it('returns 200 with token pair on valid credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: {
          email: process.env['SEED_ADMIN_EMAIL'] ?? 'admin@cctv-cloud.local',
          password: process.env['SEED_ADMIN_PASSWORD'] ?? 'changeme123!',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ accessToken: string; refreshToken: string }>();
      expect(body).toHaveProperty('accessToken');
      expect(body).toHaveProperty('refreshToken');
      expect(typeof body.accessToken).toBe('string');
      expect(typeof body.refreshToken).toBe('string');
    });

    it('returns 401 on wrong password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: {
          email: process.env['SEED_ADMIN_EMAIL'] ?? 'admin@cctv-cloud.local',
          password: 'wrongpassword',
        },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('returns 401 on non-existent user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: {
          email: 'nobody@example.com',
          password: 'somepassword123',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 400 on invalid email format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
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
        url: '/api/v1/admin/auth/login',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/admin/auth/refresh', () => {
    let refreshToken: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: {
          email: process.env['SEED_ADMIN_EMAIL'] ?? 'admin@cctv-cloud.local',
          password: process.env['SEED_ADMIN_PASSWORD'] ?? 'changeme123!',
        },
      });
      const body = res.json<{ refreshToken: string }>();
      refreshToken = body.refreshToken;
    });

    it('returns 200 with new token pair', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/refresh',
        payload: { refreshToken },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ accessToken: string; refreshToken: string }>();
      expect(body).toHaveProperty('accessToken');
      expect(body).toHaveProperty('refreshToken');
      // Token rotation — new refresh token should be different
      expect(body.refreshToken).not.toBe(refreshToken);

      // Update for next test
      refreshToken = body.refreshToken;
    });

    it('returns 401 when refresh token is reused (revoked after rotation)', async () => {
      // First use
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/refresh',
        payload: { refreshToken },
      });
      expect(res1.statusCode).toBe(200);

      // Reuse the same token — should be revoked now
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/refresh',
        payload: { refreshToken },
      });
      expect(res2.statusCode).toBe(401);
      const body = res2.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('TOKEN_REVOKED');
    });

    it('returns 401 on invalid token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/refresh',
        payload: { refreshToken: 'not.a.valid.token' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/admin/auth/logout', () => {
    let accessToken: string;
    let refreshToken: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: {
          email: process.env['SEED_ADMIN_EMAIL'] ?? 'admin@cctv-cloud.local',
          password: process.env['SEED_ADMIN_PASSWORD'] ?? 'changeme123!',
        },
      });
      const body = res.json<{ accessToken: string; refreshToken: string }>();
      accessToken = body.accessToken;
      refreshToken = body.refreshToken;
    });

    it('returns 204 on successful logout', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/logout',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { refreshToken },
      });

      expect(res.statusCode).toBe(204);
    });

    it('refresh token is revoked after logout', async () => {
      // The token was already logged out above — try to use it
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/refresh',
        payload: { refreshToken },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 401 without authorization header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/logout',
        payload: { refreshToken: 'sometoken' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /health', () => {
    it('returns 200 with health status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ status: string; db: string; redis: string }>();
      expect(body.status).toBe('ok');
      expect(body.db).toBe('ok');
      expect(body.redis).toBe('ok');
    });
  });
});
