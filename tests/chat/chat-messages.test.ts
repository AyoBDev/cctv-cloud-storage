import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Chat Messages', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let viewerId: string;
  let groupId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);

    const org = await createOrgAndLogin(app, superAdminToken, 'chat-msg');
    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create a viewer user and login
    const viewerEmail = `viewer-msg-${Date.now()}@example.com`;
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

    // Create a group as org admin
    const groupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/groups',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Message Test Group' },
    });
    groupId = groupRes.json<{ id: string }>().id;

    // Add viewer to the group
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

  describe('POST /api/v1/chat/groups/:groupId/messages', () => {
    it('sends a text message and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { content: 'Hello, team!', type: 'text' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; content: string; type: string; sender_id: string }>();
      expect(body.content).toBe('Hello, team!');
      expect(body.type).toBe('text');
      expect(body.sender_id).toBeDefined();
      expect(body.id).toBeDefined();
    });

    it('returns 403 if not a member', async () => {
      // Create a new user that is not a member of the group
      const nonMemberEmail = `non-member-${Date.now()}@example.com`;
      const nonMemberPassword = 'password123!';
      await app.inject({
        method: 'POST',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { email: nonMemberEmail, password: nonMemberPassword },
      });
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: nonMemberEmail, password: nonMemberPassword },
      });
      const nonMemberToken = loginRes.json<{ accessToken: string }>().accessToken;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${nonMemberToken}` },
        payload: { content: 'Trying to send', type: 'text' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /api/v1/chat/groups/:groupId/messages', () => {
    let msgIds: string[];

    beforeAll(async () => {
      msgIds = [];
      // Send 3 messages with slight delays to ensure ordering
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/chat/groups/${groupId}/messages`,
          headers: { authorization: `Bearer ${orgAdminAccessToken}` },
          payload: { content: `Pagination msg ${i}`, type: 'text' },
        });
        msgIds.push(res.json<{ id: string }>().id);
      }
    });

    it('returns paginated history with cursor', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/chat/groups/${groupId}/messages?limit=2`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        data: Array<{ id: string; content: string }>;
        cursor: string | null;
      }>();
      expect(body.data.length).toBe(2);
      expect(body.cursor).not.toBeNull();

      // Fetch next page with cursor
      const res2 = await app.inject({
        method: 'GET',
        url: `/api/v1/chat/groups/${groupId}/messages?limit=2&cursor=${body.cursor}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res2.statusCode).toBe(200);
      const body2 = res2.json<{ data: Array<{ id: string }>; cursor: string | null }>();
      expect(body2.data.length).toBeGreaterThan(0);
    });
  });

  describe('PATCH /api/v1/chat/groups/:groupId/messages/:messageId', () => {
    let messageId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { content: 'Original content', type: 'text' },
      });
      messageId = res.json<{ id: string }>().id;
    });

    it('sender can edit their own message', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/groups/${groupId}/messages/${messageId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { content: 'Edited content' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ content: string; edited_at: string }>();
      expect(body.content).toBe('Edited content');
      expect(body.edited_at).not.toBeNull();
    });

    it('other user gets 403 when trying to edit', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/chat/groups/${groupId}/messages/${messageId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { content: 'Hacked content' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('DELETE /api/v1/chat/groups/:groupId/messages/:messageId', () => {
    it('sender can delete their own message', async () => {
      const sendRes = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { content: 'To be deleted by sender', type: 'text' },
      });
      const messageId = sendRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/chat/groups/${groupId}/messages/${messageId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ deleted: boolean }>();
      expect(body.deleted).toBe(true);
    });

    it('group owner can delete others messages', async () => {
      // Viewer sends a message
      const sendRes = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { content: 'To be deleted by owner', type: 'text' },
      });
      const messageId = sendRes.json<{ id: string }>().id;

      // Org admin (owner of the group) deletes it
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/chat/groups/${groupId}/messages/${messageId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ deleted: boolean }>();
      expect(body.deleted).toBe(true);
    });
  });

  describe('Reactions', () => {
    let messageId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { content: 'React to this', type: 'text' },
      });
      messageId = res.json<{ id: string }>().id;
    });

    it('adds a reaction and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages/${messageId}/reactions`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { emoji: '👍' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ added: boolean }>();
      expect(body.added).toBe(true);
    });

    it('removes a reaction and returns 200', async () => {
      const emoji = encodeURIComponent('👍');
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/chat/groups/${groupId}/messages/${messageId}/reactions/${emoji}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ removed: boolean }>();
      expect(body.removed).toBe(true);
    });
  });

  describe('Read receipts', () => {
    it('marks messages as read and returns 200', async () => {
      // Send a message to get a valid message ID
      const sendRes = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/messages`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { content: 'Read this', type: 'text' },
      });
      const messageId = sendRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/read`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { lastReadMessageId: messageId },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ success: boolean }>();
      expect(body.success).toBe(true);
    });
  });

  describe('POST /api/v1/chat/groups/:groupId/media/upload', () => {
    it('returns a pre-signed upload URL', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/media/upload`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { fileName: 'photo.jpg', contentType: 'image/jpeg' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ uploadUrl: string; key: string }>();
      expect(body.key).toContain('chat/');
      expect(body.uploadUrl).toBeTruthy();
    });

    it('rejects disallowed content types', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/chat/groups/${groupId}/media/upload`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { fileName: 'script.exe', contentType: 'application/x-msdownload' },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
