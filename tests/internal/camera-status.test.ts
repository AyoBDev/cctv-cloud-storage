import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Internal Camera Status Webhook', () => {
  let app: FastifyInstance;
  let kvsStreamName: string;
  const internalSecret = process.env['INTERNAL_API_SECRET'] ?? 'test-secret-minimum-16-chars-long';

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'internal-cam');

    // Create a camera to get a kvs_stream_name
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${org.orgAdminAccessToken}` },
      payload: { name: 'Internal Test Camera' },
    });
    expect(createRes.statusCode).toBe(201);
    kvsStreamName = createRes.json<{ kvs_stream_name: string }>().kvs_stream_name;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('POST /internal/cameras/status', () => {
    it('updates camera status to offline with valid secret', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/cameras/status',
        headers: { 'x-internal-secret': internalSecret },
        payload: {
          kvs_stream_name: kvsStreamName,
          status: 'offline',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ message: string }>().message).toBe('Status updated');
    });

    it('updates camera status to online with valid secret', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/cameras/status',
        headers: { 'x-internal-secret': internalSecret },
        payload: {
          kvs_stream_name: kvsStreamName,
          status: 'online',
        },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 401 without secret header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/cameras/status',
        payload: {
          kvs_stream_name: kvsStreamName,
          status: 'offline',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 401 with wrong secret', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/cameras/status',
        headers: { 'x-internal-secret': 'wrong-secret-value' },
        payload: {
          kvs_stream_name: kvsStreamName,
          status: 'offline',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 404 for non-existent stream name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/cameras/status',
        headers: { 'x-internal-secret': internalSecret },
        payload: {
          kvs_stream_name: 'non-existent-stream',
          status: 'offline',
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for invalid status', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/cameras/status',
        headers: { 'x-internal-secret': internalSecret },
        payload: {
          kvs_stream_name: kvsStreamName,
          status: 'invalid',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/cameras/status',
        headers: { 'x-internal-secret': internalSecret },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
