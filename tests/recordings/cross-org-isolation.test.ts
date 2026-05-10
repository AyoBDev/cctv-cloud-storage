import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Recordings - Cross-Org Isolation', () => {
  let app: FastifyInstance;
  let orgAToken: string;
  let orgBToken: string;
  let orgACameraId: string;
  let orgARecordingId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const internalSecret = process.env['INTERNAL_API_SECRET'] ?? 'test-internal-secret-1234567890';

    const orgA = await createOrgAndLogin(app, superAdminToken, 'rec-iso-a');
    orgAToken = orgA.orgAdminAccessToken;

    const orgB = await createOrgAndLogin(app, superAdminToken, 'rec-iso-b');
    orgBToken = orgB.orgAdminAccessToken;

    // Create camera in Org A
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAToken}` },
      payload: { name: 'Isolation Camera' },
    });
    orgACameraId = camRes.json<{ id: string }>().id;

    // Create recording in Org A
    const recRes = await app.inject({
      method: 'POST',
      url: '/internal/recordings',
      headers: { 'x-internal-secret': internalSecret },
      payload: {
        org_id: orgA.orgId,
        camera_id: orgACameraId,
        s3_key: `orgs/${orgA.orgId}/cameras/${orgACameraId}/2026-05-10/10-00.mp4`,
        start_time: '2026-05-10T10:00:00.000Z',
        end_time: '2026-05-10T10:05:00.000Z',
        duration_seconds: 300,
        file_size_bytes: 10000000,
      },
    });
    orgARecordingId = recRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('Org B cannot list Org A camera recordings', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${orgACameraId}/recordings?start_date=2026-05-10T00:00:00.000Z&end_date=2026-05-10T23:59:59.000Z`,
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }> }>();
    expect(body.data.length).toBe(0);
  });

  it('Org B cannot access Org A recording by ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${orgACameraId}/recordings/${orgARecordingId}`,
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
