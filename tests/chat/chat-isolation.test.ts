import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Chat Cross-Org Isolation', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgAToken: string;
  let orgBToken: string;
  let orgAGroupId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);

    const orgA = await createOrgAndLogin(app, superAdminToken, 'chat-iso-a');
    orgAToken = orgA.orgAdminAccessToken;

    const orgB = await createOrgAndLogin(app, superAdminToken, 'chat-iso-b');
    orgBToken = orgB.orgAdminAccessToken;

    // Create a group in Org A
    const groupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/groups',
      headers: { authorization: `Bearer ${orgAToken}` },
      payload: { name: 'Org A Secret Chat' },
    });
    orgAGroupId = groupRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('Org B user cannot see Org A groups in list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/chat/groups',
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<Array<{ id: string }>>();
    const ids = body.map((g) => g.id);
    expect(ids).not.toContain(orgAGroupId);
  });

  it('Org B user cannot access Org A group details', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chat/groups/${orgAGroupId}`,
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    // Should be 403 (not a member / group not found for this org) or 404
    expect([403, 404]).toContain(res.statusCode);
  });

  it('Org B user cannot send messages in Org A group', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chat/groups/${orgAGroupId}/messages`,
      headers: { authorization: `Bearer ${orgBToken}` },
      payload: { content: 'Cross-org attack', type: 'text' },
    });

    expect([403, 404]).toContain(res.statusCode);
  });

  it('Org B user cannot add themselves to Org A group', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chat/groups/${orgAGroupId}/members`,
      headers: { authorization: `Bearer ${orgBToken}` },
      payload: { userIds: ['00000000-0000-0000-0000-000000000000'] },
    });

    expect([403, 404]).toContain(res.statusCode);
  });

  it('Org B user cannot delete Org A group', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/chat/groups/${orgAGroupId}`,
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect([403, 404]).toContain(res.statusCode);
  });
});
