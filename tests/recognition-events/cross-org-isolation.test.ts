import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Recognition Events - Cross-Org Isolation', () => {
  let app: FastifyInstance;
  let orgAToken: string;
  let orgBToken: string;
  let orgAEventId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);

    const orgA = await createOrgAndLogin(app, superAdminToken, 're-iso-a');
    orgAToken = orgA.orgAdminAccessToken;

    const orgB = await createOrgAndLogin(app, superAdminToken, 're-iso-b');
    orgBToken = orgB.orgAdminAccessToken;

    // Create a camera in Org A
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAToken}` },
      payload: { name: 'Isolation Camera' },
    });
    const cameraId = camRes.json<{ id: string }>().id;

    // Create a recognition event in Org A via internal endpoint
    const internalSecret = process.env['INTERNAL_API_SECRET'] ?? 'test-internal-secret-1234567890';
    const eventRes = await app.inject({
      method: 'POST',
      url: '/internal/recognition-events',
      headers: { 'x-internal-secret': internalSecret },
      payload: {
        org_id: orgA.orgId,
        camera_id: cameraId,
        image_bytes: Buffer.from('iso-test').toString('base64'),
        confidence: 85.0,
        face_profile_id: null,
        event_type: 'known_face',
      },
    });
    orgAEventId = eventRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('Org B cannot see Org A events in list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/recognition-events',
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }> }>();
    const ids = body.data.map((e) => e.id);
    expect(ids).not.toContain(orgAEventId);
  });

  it('Org B cannot access Org A event by ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/recognition-events/${orgAEventId}`,
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
