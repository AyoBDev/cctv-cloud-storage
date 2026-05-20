import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Chat Moderation', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgId: string;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let viewerId: string;
  let groupId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);

    const org = await createOrgAndLogin(app, superAdminToken, 'moderation');
    orgId = org.orgId;
    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create a viewer user and login
    const viewerEmail = `viewer-mod-${Date.now()}@example.com`;
    const viewerPassword = 'password123!';
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerId = viewerRes.json<{ id: string }>().id;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerAccessToken = loginRes.json<{ accessToken: string }>().accessToken;

    // Create a group and add the viewer
    const groupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/groups',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Moderation Test Group' },
    });
    groupId = groupRes.json<{ id: string }>().id;

    await app.inject({
      method: 'POST',
      url: `/api/v1/chat/groups/${groupId}/members`,
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { userIds: [viewerId] },
    });
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('Muting', () => {
    it('muted viewer cannot send messages (403)', async () => {
      // Mute the viewer
      const muteRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/groups/${groupId}/members/${viewerId}/mute`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { duration: 60 },
      });
      expect(muteRes.statusCode).toBe(200);

      // Try to send a message as the muted viewer
      const msgRes = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { content: 'I am muted' },
      });
      expect(msgRes.statusCode).toBe(403);
    });

    it('unmuted viewer can send messages again', async () => {
      // Unmute the viewer
      const unmuteRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/groups/${groupId}/members/${viewerId}/unmute`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
      expect(unmuteRes.statusCode).toBe(200);

      // Now the viewer should be able to send a message
      const msgRes = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { content: 'I am no longer muted' },
      });
      expect(msgRes.statusCode).toBe(201);
    });
  });

  describe('Reports', () => {
    it('member reports another user (201)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/reports`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: {
          reportedUser: viewerId, // self-report for test simplicity
          reason: 'Inappropriate behavior in chat',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; group_id: string; reason: string; status: string }>();
      expect(body.id).toBeDefined();
      expect(body.group_id).toBe(groupId);
      expect(body.reason).toBe('Inappropriate behavior in chat');
      expect(body.status).toBe('pending');
    });

    it('org admin lists reports (200)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/chat/reports',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ id: string; reason: string }> }>();
      expect(body.data).toBeDefined();
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data[0]!.reason).toBe('Inappropriate behavior in chat');
    });

    it('org admin updates report status to reviewed (200)', async () => {
      // First get reports to find the ID
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/v1/chat/reports',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
      const reports = listRes.json<{ data: Array<{ id: string }> }>();
      const reportId = reports.data[0]!.id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/reports/${reportId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { status: 'reviewed' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; status: string }>();
      expect(body.status).toBe('reviewed');
    });

    it('non-admin cannot list reports (403)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/chat/reports',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
