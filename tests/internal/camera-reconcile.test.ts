import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Internal Camera Reconcile', () => {
  let app: FastifyInstance;
  let kvsStreamName: string;
  let orgAdminToken: string;
  const internalSecret = process.env['INTERNAL_API_SECRET'] ?? 'test-secret-minimum-16-chars-long';

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'reconcile-cam');
    orgAdminToken = org.orgAdminAccessToken;

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminToken}` },
      payload: { name: 'Reconcile Test Camera' },
    });
    expect(createRes.statusCode).toBe(201);
    kvsStreamName = createRes.json<{ kvs_stream_name: string }>().kvs_stream_name;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('GET /internal/cameras/reconcile-list', () => {
    it('returns stream names with valid secret', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/cameras/reconcile-list',
        headers: { 'x-internal-secret': internalSecret },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ cameras: { kvs_stream_name: string }[] }>();
      expect(body.cameras.some((c) => c.kvs_stream_name === kvsStreamName)).toBe(true);
    });

    it('returns 401 without secret', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/cameras/reconcile-list',
      });
      expect(res.statusCode).toBe(401);
    });

    it('is not reachable with an org user JWT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/cameras/reconcile-list',
        headers: { authorization: `Bearer ${orgAdminToken}` },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /internal/cameras/reconcile', () => {
    it('promotes camera to online when has_media', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/cameras/reconcile',
        headers: { 'x-internal-secret': internalSecret },
        payload: { updates: [{ kvs_stream_name: kvsStreamName, has_media: true }] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        results: { kvs_stream_name: string; status: string }[];
      }>();
      expect(body.results[0]).toMatchObject({
        kvs_stream_name: kvsStreamName,
        status: 'online',
      });
    });

    it('returns 400 for malformed body (missing has_media)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/cameras/reconcile',
        headers: { 'x-internal-secret': internalSecret },
        payload: { updates: [{ kvs_stream_name: kvsStreamName }] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without secret', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/cameras/reconcile',
        payload: { updates: [] },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
