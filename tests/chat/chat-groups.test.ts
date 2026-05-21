import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Chat Groups', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgId: string;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let viewerId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);

    const org = await createOrgAndLogin(app, superAdminToken, 'chat');
    orgId = org.orgId;
    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create a viewer user and login
    const viewerEmail = `viewer-chat-${Date.now()}@example.com`;
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
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('POST /api/v1/chat/groups', () => {
    it('creates a group and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Security Team', description: 'Discussion for security ops' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; name: string; description: string; org_id: string }>();
      expect(body.name).toBe('Security Team');
      expect(body.description).toBe('Discussion for security ops');
      expect(body.org_id).toBe(orgId);
      expect(body.id).toBeDefined();
    });

    it('viewer can create a group', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { name: 'Viewer Group' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ name: string }>();
      expect(body.name).toBe('Viewer Group');
    });

    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        payload: { name: 'No Auth Group' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when name is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { description: 'No name' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/chat/groups', () => {
    it('lists groups the user belongs to', async () => {
      // Create a group as org admin
      await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'List Test Group' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<Array<{ id: string; name: string }>>();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
    });

    it('viewer only sees their own groups', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<Array<{ id: string; name: string }>>();
      // Viewer created "Viewer Group" earlier
      const viewerGroups = body.filter((g) => g.name === 'Viewer Group');
      expect(viewerGroups.length).toBe(1);
    });
  });

  describe('POST /api/v1/chat/groups/:groupId/members', () => {
    let groupId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Members Test Group' },
      });
      groupId = res.json<{ id: string }>().id;
    });

    it('adds members to the group', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/members`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { userIds: [viewerId] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ added: number }>();
      expect(body.added).toBe(1);
    });

    it('returns 403 if not a member', async () => {
      // Create a second viewer that's not in the group
      const viewer2Email = `viewer-chat2-${Date.now()}@example.com`;
      const viewer2Password = 'password123!';
      await app.inject({
        method: 'POST',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { email: viewer2Email, password: viewer2Password },
      });
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: viewer2Email, password: viewer2Password },
      });
      const viewer2Token = loginRes.json<{ accessToken: string }>().accessToken;

      // Create a new group by orgAdmin and don't add viewer2
      const groupRes = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Restricted Group' },
      });
      const restrictedGroupId = groupRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${restrictedGroupId}/members`,
        headers: { authorization: `Bearer ${viewer2Token}` },
        payload: { userIds: [viewerId] },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('DELETE /api/v1/chat/groups/:groupId/members/:userId', () => {
    let groupId: string;

    beforeAll(async () => {
      // Create a group and add the viewer
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Remove Member Test' },
      });
      groupId = res.json<{ id: string }>().id;

      await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/members`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { userIds: [viewerId] },
      });
    });

    it('owner removes a member', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/chat/groups/${groupId}/members/${viewerId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(204);
    });

    it('viewer can self-leave', async () => {
      // First add the viewer back
      await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/members`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { userIds: [viewerId] },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/chat/groups/${groupId}/members/${viewerId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(204);
    });
  });

  describe('PATCH /api/v1/chat/groups/:groupId', () => {
    let groupId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Update Test Group' },
      });
      groupId = res.json<{ id: string }>().id;
    });

    it('owner updates the group', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/groups/${groupId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Renamed Group', description: 'New description' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ name: string; description: string }>();
      expect(body.name).toBe('Renamed Group');
      expect(body.description).toBe('New description');
    });

    it('non-owner member gets 403', async () => {
      // Add viewer to group and try to update
      await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/members`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { userIds: [viewerId] },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/groups/${groupId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { name: 'Hacked Name' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('DELETE /api/v1/chat/groups/:groupId', () => {
    it('owner deletes the group and returns 204', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Delete Me Group' },
      });
      const groupId = createRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/chat/groups/${groupId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(204);

      // Verify it's gone
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/chat/groups/${groupId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
      expect(getRes.statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/chat/groups/:groupId', () => {
    it('returns group with members', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Detail Group' },
      });
      const groupId = createRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/chat/groups/${groupId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        id: string;
        name: string;
        members: Array<{ user_id: string; role: string; email: string }>;
      }>();
      expect(body.name).toBe('Detail Group');
      expect(body.members).toBeDefined();
      expect(body.members.length).toBe(1);
      expect(body.members[0]!.role).toBe('owner');
    });

    it('returns 403 for non-member', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Private Group' },
      });
      const groupId = createRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/chat/groups/${groupId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('PATCH /api/v1/chat/groups/:groupId/members/:userId/mute', () => {
    let groupId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/groups',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Mute Test Group' },
      });
      groupId = res.json<{ id: string }>().id;

      await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/members`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { userIds: [viewerId] },
      });
    });

    it('owner mutes a member', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/groups/${groupId}/members/${viewerId}/mute`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { duration: 60 },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ muted_until: string }>();
      expect(body.muted_until).toBeDefined();
    });

    it('owner unmutes a member', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/groups/${groupId}/members/${viewerId}/unmute`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ muted_until: null }>();
      expect(body.muted_until).toBeNull();
    });

    it('non-owner cannot mute', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/groups/${groupId}/members/${viewerId}/mute`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { duration: 60 },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
