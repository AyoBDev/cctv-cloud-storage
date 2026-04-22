import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Camera Credentials', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgId: string;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let cameraId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);

    const org = await createOrgAndLogin(app, superAdminToken, 'creds');
    orgId = org.orgId;
    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create a viewer
    const viewerEmail = `viewer-creds-${Date.now()}@example.com`;
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

    // Create a camera for testing
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Credentials Test Camera' },
    });
    cameraId = camRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('GET /api/v1/cameras/:cameraId/credentials', () => {
    it('returns 200 with credential bundle on first download', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/credentials`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        device_cert: string;
        private_key: string;
        root_ca_url: string;
        iot_credential_endpoint: string;
        kvs_stream_name: string;
        role_alias: string;
        region: string;
      }>();

      expect(body.device_cert).toContain('BEGIN CERTIFICATE');
      expect(body.private_key).toContain('BEGIN RSA PRIVATE KEY');
      expect(body.root_ca_url).toContain('amazontrust.com');
      expect(body.iot_credential_endpoint).toBeTruthy();
      expect(body.kvs_stream_name).toMatch(/^[a-z0-9-]+-cam\d+$/);
      expect(body.role_alias).toBeTruthy();
      expect(body.region).toBeTruthy();
    });

    it('returns 409 on second download attempt', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/credentials`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json<{ error: { code: string; message: string } }>();
      expect(body.error.message).toContain('already issued');
    });

    it('returns 403 for viewer (requireOrgAdmin)', async () => {
      // Create a fresh camera so credentials haven't been issued
      const camRes = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Viewer Creds Test' },
      });
      const freshCamId = camRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${freshCamId}/credentials`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 403 for wrong org', async () => {
      // Create a second org
      const org2 = await createOrgAndLogin(app, superAdminToken, 'creds-org2');

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/credentials`,
        headers: { authorization: `Bearer ${org2.orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 404 for non-existent camera', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras/00000000-0000-0000-0000-000000000000/credentials',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/credentials`,
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
