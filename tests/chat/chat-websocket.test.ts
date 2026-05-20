import { buildApp } from '../../src/app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import type { AddressInfo } from 'net';

function connectWs(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/chat/ws?token=${token}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Connection timeout')), 5000);
  });
}

function waitForEvent(
  ws: WebSocket,
  eventName: string,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${eventName}`)),
      timeoutMs,
    );
    const handler = (data: WebSocket.Data) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      if (parsed.event === eventName) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(parsed);
      }
    };
    ws.on('message', handler);
  });
}

function sendEvent(ws: WebSocket, payload: Record<string, unknown>): void {
  ws.send(JSON.stringify(payload));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Chat WebSocket', () => {
  let app: FastifyInstance;
  let port: number;
  let superAdminToken: string;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let viewerId: string;
  let groupId: string;
  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;

    superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'chat-ws');
    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create a viewer user
    const viewerEmail = `viewer-ws-${Date.now()}@example.com`;
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

    // Create a group
    const groupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/groups',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'WS Test Group' },
    });
    groupId = groupRes.json<{ id: string }>().id;

    // Add viewer to the group
    await app.inject({
      method: 'POST',
      url: `/api/v1/chat/groups/${groupId}/members`,
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { userIds: [viewerId] },
    });
  }, 30000);

  afterEach(() => {
    // Close any sockets opened during the test
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    openSockets.length = 0;
  });

  afterAll(async () => {
    await app.close();
  }, 15000);

  function trackSocket(ws: WebSocket): WebSocket {
    openSockets.push(ws);
    return ws;
  }

  describe('Connection', () => {
    it('connects with a valid token', async () => {
      const ws = trackSocket(await connectWs(port, orgAdminAccessToken));
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('rejects connection without a token', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/chat/ws`);
      trackSocket(ws);

      await new Promise<void>((resolve) => {
        ws.on('close', (code) => {
          expect(code).toBe(4001);
          resolve();
        });
        ws.on('error', () => resolve());
      });
    });

    it('rejects connection with an invalid token', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/api/v1/chat/ws?token=invalid-token`,
      );
      trackSocket(ws);

      await new Promise<void>((resolve) => {
        ws.on('close', (code) => {
          expect(code).toBe(4001);
          resolve();
        });
        ws.on('error', () => resolve());
      });
    });
  });

  describe('Join/Leave', () => {
    it('joins a group the user is a member of', async () => {
      const ws = trackSocket(await connectWs(port, orgAdminAccessToken));

      sendEvent(ws, { event: 'join', groupId });
      const response = await waitForEvent(ws, 'joined');
      expect(response.groupId).toBe(groupId);
    });

    it('rejects joining a group the user is not a member of', async () => {
      const ws = trackSocket(await connectWs(port, orgAdminAccessToken));

      sendEvent(ws, {
        event: 'join',
        groupId: '00000000-0000-0000-0000-000000000000',
      });
      const response = await waitForEvent(ws, 'error');
      expect(response.code).toBe('FORBIDDEN');
    });

    it('leaves a group', async () => {
      const ws = trackSocket(await connectWs(port, orgAdminAccessToken));

      sendEvent(ws, { event: 'join', groupId });
      await waitForEvent(ws, 'joined');

      sendEvent(ws, { event: 'leave', groupId });
      const response = await waitForEvent(ws, 'left');
      expect(response.groupId).toBe(groupId);
    });
  });

  describe('Message broadcasting', () => {
    it('broadcasts a message to other group members', async () => {
      const ws1 = trackSocket(await connectWs(port, orgAdminAccessToken));
      const ws2 = trackSocket(await connectWs(port, viewerAccessToken));

      // Both join the group
      sendEvent(ws1, { event: 'join', groupId });
      await waitForEvent(ws1, 'joined');

      sendEvent(ws2, { event: 'join', groupId });
      await waitForEvent(ws2, 'joined');

      // Small delay to ensure subscriptions are active
      await delay(100);

      // ws1 sends a message
      sendEvent(ws1, {
        event: 'message:send',
        groupId,
        content: 'Hello from ws1!',
        type: 'text',
      });

      // ws1 should get message:new back (direct send)
      const senderMsg = await waitForEvent(ws1, 'message:new');
      expect((senderMsg.message as Record<string, unknown>).content).toBe('Hello from ws1!');

      // ws2 should also receive the message (via pub/sub)
      const receiverMsg = await waitForEvent(ws2, 'message:new');
      expect((receiverMsg.message as Record<string, unknown>).content).toBe('Hello from ws1!');
    });

    it('does not deliver messages to unjoined clients', async () => {
      const ws1 = trackSocket(await connectWs(port, orgAdminAccessToken));
      const ws2 = trackSocket(await connectWs(port, viewerAccessToken));

      // Only ws1 joins the group
      sendEvent(ws1, { event: 'join', groupId });
      await waitForEvent(ws1, 'joined');
      await delay(100);

      // ws1 sends a message
      sendEvent(ws1, {
        event: 'message:send',
        groupId,
        content: 'Private to joined users',
        type: 'text',
      });

      // ws1 gets message:new
      await waitForEvent(ws1, 'message:new');

      // ws2 should NOT receive anything (we wait briefly and check)
      const received = await Promise.race([
        waitForEvent(ws2, 'message:new', 500).then(() => true).catch(() => false),
        delay(600).then(() => false),
      ]);
      expect(received).toBe(false);
    });

    it('prevents sending when not joined', async () => {
      const ws = trackSocket(await connectWs(port, orgAdminAccessToken));

      sendEvent(ws, {
        event: 'message:send',
        groupId,
        content: 'Should fail',
        type: 'text',
      });

      const response = await waitForEvent(ws, 'error');
      expect(response.code).toBe('NOT_JOINED');
    });
  });

  describe('Typing indicators', () => {
    it('broadcasts typing:start to other users in the group', async () => {
      const ws1 = trackSocket(await connectWs(port, orgAdminAccessToken));
      const ws2 = trackSocket(await connectWs(port, viewerAccessToken));

      sendEvent(ws1, { event: 'join', groupId });
      await waitForEvent(ws1, 'joined');

      sendEvent(ws2, { event: 'join', groupId });
      await waitForEvent(ws2, 'joined');
      await delay(100);

      sendEvent(ws1, { event: 'typing:start', groupId });

      const typingEvent = await waitForEvent(ws2, 'typing');
      expect(typingEvent.isTyping).toBe(true);
      expect(typingEvent.groupId).toBe(groupId);
    });

    it('broadcasts typing:stop to other users in the group', async () => {
      const ws1 = trackSocket(await connectWs(port, orgAdminAccessToken));
      const ws2 = trackSocket(await connectWs(port, viewerAccessToken));

      sendEvent(ws1, { event: 'join', groupId });
      await waitForEvent(ws1, 'joined');

      sendEvent(ws2, { event: 'join', groupId });
      await waitForEvent(ws2, 'joined');
      await delay(100);

      sendEvent(ws1, { event: 'typing:stop', groupId });

      const typingEvent = await waitForEvent(ws2, 'typing');
      expect(typingEvent.isTyping).toBe(false);
    });
  });

  describe('Message edit and delete', () => {
    it('broadcasts message:edited to group members', async () => {
      const ws1 = trackSocket(await connectWs(port, orgAdminAccessToken));
      const ws2 = trackSocket(await connectWs(port, viewerAccessToken));

      sendEvent(ws1, { event: 'join', groupId });
      await waitForEvent(ws1, 'joined');

      sendEvent(ws2, { event: 'join', groupId });
      await waitForEvent(ws2, 'joined');
      await delay(100);

      // Send a message
      sendEvent(ws1, {
        event: 'message:send',
        groupId,
        content: 'Original message',
        type: 'text',
      });

      const msgEvent = await waitForEvent(ws1, 'message:new');
      const messageId = (msgEvent.message as Record<string, unknown>).id as string;

      // Consume the message on ws2 side
      await waitForEvent(ws2, 'message:new');
      await delay(50);

      // Edit the message
      sendEvent(ws1, {
        event: 'message:edit',
        messageId,
        content: 'Edited message',
      });

      const editedSender = await waitForEvent(ws1, 'message:edited');
      expect(editedSender.content).toBe('Edited message');

      const editedReceiver = await waitForEvent(ws2, 'message:edited');
      expect(editedReceiver.content).toBe('Edited message');
      expect(editedReceiver.messageId).toBe(messageId);
    });

    it('broadcasts message:deleted to group members', async () => {
      const ws1 = trackSocket(await connectWs(port, orgAdminAccessToken));
      const ws2 = trackSocket(await connectWs(port, viewerAccessToken));

      sendEvent(ws1, { event: 'join', groupId });
      await waitForEvent(ws1, 'joined');

      sendEvent(ws2, { event: 'join', groupId });
      await waitForEvent(ws2, 'joined');
      await delay(100);

      // Send a message
      sendEvent(ws1, {
        event: 'message:send',
        groupId,
        content: 'To be deleted',
        type: 'text',
      });

      const msgEvent = await waitForEvent(ws1, 'message:new');
      const messageId = (msgEvent.message as Record<string, unknown>).id as string;
      await waitForEvent(ws2, 'message:new');
      await delay(50);

      // Delete the message
      sendEvent(ws1, { event: 'message:delete', messageId });

      const deletedSender = await waitForEvent(ws1, 'message:deleted');
      expect(deletedSender.messageId).toBe(messageId);

      const deletedReceiver = await waitForEvent(ws2, 'message:deleted');
      expect(deletedReceiver.messageId).toBe(messageId);
    });

    it('prevents editing another user\'s message', async () => {
      const ws1 = trackSocket(await connectWs(port, orgAdminAccessToken));
      const ws2 = trackSocket(await connectWs(port, viewerAccessToken));

      sendEvent(ws1, { event: 'join', groupId });
      await waitForEvent(ws1, 'joined');

      sendEvent(ws2, { event: 'join', groupId });
      await waitForEvent(ws2, 'joined');
      await delay(100);

      // ws1 sends a message
      sendEvent(ws1, {
        event: 'message:send',
        groupId,
        content: 'My message',
        type: 'text',
      });

      const msgEvent = await waitForEvent(ws1, 'message:new');
      const messageId = (msgEvent.message as Record<string, unknown>).id as string;
      await waitForEvent(ws2, 'message:new');
      await delay(50);

      // ws2 tries to edit ws1's message
      sendEvent(ws2, {
        event: 'message:edit',
        messageId,
        content: 'Hacked!',
      });

      const errorEvent = await waitForEvent(ws2, 'error');
      expect(errorEvent.code).toBe('FORBIDDEN');
    });
  });

  describe('Reactions', () => {
    it('broadcasts reaction:added to group members', async () => {
      const ws1 = trackSocket(await connectWs(port, orgAdminAccessToken));
      const ws2 = trackSocket(await connectWs(port, viewerAccessToken));

      sendEvent(ws1, { event: 'join', groupId });
      await waitForEvent(ws1, 'joined');

      sendEvent(ws2, { event: 'join', groupId });
      await waitForEvent(ws2, 'joined');
      await delay(100);

      // Send a message
      sendEvent(ws1, {
        event: 'message:send',
        groupId,
        content: 'React to this!',
        type: 'text',
      });

      const msgEvent = await waitForEvent(ws1, 'message:new');
      const messageId = (msgEvent.message as Record<string, unknown>).id as string;
      await waitForEvent(ws2, 'message:new');
      await delay(50);

      // ws2 adds a reaction
      sendEvent(ws2, { event: 'reaction:add', messageId, emoji: '👍' });

      const reactionSender = await waitForEvent(ws2, 'reaction:added');
      expect(reactionSender.emoji).toBe('👍');

      const reactionReceiver = await waitForEvent(ws1, 'reaction:added');
      expect(reactionReceiver.emoji).toBe('👍');
      expect(reactionReceiver.messageId).toBe(messageId);
    });
  });

  describe('Validation', () => {
    it('returns error for invalid JSON', async () => {
      const ws = trackSocket(await connectWs(port, orgAdminAccessToken));
      ws.send('not-json');

      const response = await waitForEvent(ws, 'error');
      expect(response.code).toBe('PARSE_ERROR');
    });

    it('returns error for invalid event schema', async () => {
      const ws = trackSocket(await connectWs(port, orgAdminAccessToken));
      ws.send(JSON.stringify({ event: 'unknown_event' }));

      const response = await waitForEvent(ws, 'error');
      expect(response.code).toBe('VALIDATION_ERROR');
    });
  });
});
