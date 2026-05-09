import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Face Profiles - Cross-Org Isolation', () => {
  let app: FastifyInstance;
  let orgAToken: string;
  let orgBToken: string;
  let orgAProfileId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);

    const orgA = await createOrgAndLogin(app, superAdminToken, 'fp-iso-a');
    orgAToken = orgA.orgAdminAccessToken;

    const orgB = await createOrgAndLogin(app, superAdminToken, 'fp-iso-b');
    orgBToken = orgB.orgAdminAccessToken;

    // Create a face profile in Org A
    const form = new FormData();
    form.append('label', 'Org A Face');
    form.append('image', new Blob([Buffer.alloc(100)], { type: 'image/jpeg' }), 'face.jpg');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/face-profiles',
      headers: { authorization: `Bearer ${orgAToken}` },
      payload: form,
    });
    orgAProfileId = res.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('Org B cannot see Org A face profiles in list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/face-profiles',
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }> }>();
    const ids = body.data.map((p) => p.id);
    expect(ids).not.toContain(orgAProfileId);
  });

  it('Org B cannot access Org A face profile by ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/face-profiles/${orgAProfileId}`,
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('Org B cannot delete Org A face profile', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/face-profiles/${orgAProfileId}`,
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
