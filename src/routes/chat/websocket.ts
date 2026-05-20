import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { publish, subscribe, unsubscribe, channelForGroup } from '@utils/chat-pubsub';
import { isMember, isMuted } from '@services/chat.service';
import {
  sendMessage,
  editMessage,
  deleteMessage,
  getMessageById,
  addReaction,
  removeReaction,
  markRead,
} from '@services/chat-message.service';
import type { ChatMessage } from '@services/chat-message.service';

interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  orgId: string;
  joinedGroups: Set<string>;
  channelHandlers: Map<string, (channel: string, message: string) => void>;
}

const clients = new Map<WebSocket, ConnectedClient>();

const incomingEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('join'), groupId: z.string().uuid() }),
  z.object({ event: z.literal('leave'), groupId: z.string().uuid() }),
  z.object({
    event: z.literal('message:send'),
    groupId: z.string().uuid(),
    content: z.string().min(1).max(5000),
    type: z.enum(['text', 'media']),
    mediaUrl: z.string().optional(),
    mediaType: z.string().optional(),
  }),
  z.object({
    event: z.literal('message:edit'),
    messageId: z.string().uuid(),
    content: z.string().min(1).max(5000),
  }),
  z.object({ event: z.literal('message:delete'), messageId: z.string().uuid() }),
  z.object({ event: z.literal('typing:start'), groupId: z.string().uuid() }),
  z.object({ event: z.literal('typing:stop'), groupId: z.string().uuid() }),
  z.object({
    event: z.literal('read'),
    groupId: z.string().uuid(),
    lastReadMessageId: z.string().uuid(),
  }),
  z.object({
    event: z.literal('reaction:add'),
    messageId: z.string().uuid(),
    emoji: z.string().min(1).max(32),
  }),
  z.object({
    event: z.literal('reaction:remove'),
    messageId: z.string().uuid(),
    emoji: z.string().min(1).max(32),
  }),
  z.object({
    event: z.literal('sync'),
    groups: z.array(
      z.object({ groupId: z.string().uuid(), lastMessageId: z.string().uuid() }),
    ),
  }),
]);

function sendEvent(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendError(ws: WebSocket, code: string, message: string): void {
  sendEvent(ws, { event: 'error', code, message });
}

export default async function chatWebsocketRoute(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, request) => {
    const token = (request.query as Record<string, string>).token;

    if (!token) {
      socket.close(4001, 'Missing token');
      return;
    }

    let decoded: { sub: string; org_id: string; role: string };
    try {
      decoded = app.jwt.verify<{ sub: string; org_id: string; role: string }>(token);
    } catch {
      socket.close(4001, 'Invalid token');
      return;
    }

    const client: ConnectedClient = {
      ws: socket,
      userId: decoded.sub,
      orgId: decoded.org_id,
      joinedGroups: new Set(),
      channelHandlers: new Map(),
    };
    clients.set(socket, client);

    // Heartbeat
    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.ping();
      }
    }, 30000);

    socket.on('message', (data) => {
      void handleMessage(app, client, data);
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      void cleanupClient(client);
    });

    socket.on('error', () => {
      clearInterval(heartbeat);
      void cleanupClient(client);
    });
  });
}

async function cleanupClient(client: ConnectedClient): Promise<void> {
  for (const [channel, handler] of client.channelHandlers) {
    await unsubscribe(channel, handler);
  }
  client.channelHandlers.clear();
  client.joinedGroups.clear();
  clients.delete(client.ws);
}

async function handleMessage(
  app: FastifyInstance,
  client: ConnectedClient,
  data: unknown,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(data));
  } catch {
    sendError(client.ws, 'PARSE_ERROR', 'Invalid JSON');
    return;
  }

  const result = incomingEventSchema.safeParse(parsed);
  if (!result.success) {
    sendError(client.ws, 'VALIDATION_ERROR', result.error.errors[0]?.message ?? 'Invalid event');
    return;
  }

  const event = result.data;
  const db = app.db;

  try {
    switch (event.event) {
      case 'join':
        await handleJoin(db, client, event.groupId);
        break;
      case 'leave':
        await handleLeave(client, event.groupId);
        break;
      case 'message:send':
        await handleSendMessage(db, client, event);
        break;
      case 'message:edit':
        await handleEditMessage(db, client, event);
        break;
      case 'message:delete':
        await handleDeleteMessage(db, client, event);
        break;
      case 'typing:start':
        await handleTyping(client, event.groupId, true);
        break;
      case 'typing:stop':
        await handleTyping(client, event.groupId, false);
        break;
      case 'read':
        await handleRead(db, client, event);
        break;
      case 'reaction:add':
        await handleReactionAdd(db, client, event);
        break;
      case 'reaction:remove':
        await handleReactionRemove(db, client, event);
        break;
      case 'sync':
        await handleSync(db, client, event);
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    sendError(client.ws, 'INTERNAL_ERROR', message);
  }
}

async function handleJoin(
  db: Sql,
  client: ConnectedClient,
  groupId: string,
): Promise<void> {
  const member = await isMember(db, groupId, client.userId);
  if (!member) {
    sendError(client.ws, 'FORBIDDEN', 'Not a member of this group');
    return;
  }

  const channel = channelForGroup(groupId);
  if (client.joinedGroups.has(groupId)) return;

  client.joinedGroups.add(groupId);

  const handler = (_ch: string, message: string) => {
    try {
      const payload = JSON.parse(message) as Record<string, unknown>;
      // Skip echoing back to sender
      if (payload._senderId === client.userId) return;
      // Strip internal field before forwarding
      const { _senderId: _, ...clean } = payload;
      sendEvent(client.ws, clean);
    } catch {
      // ignore malformed messages
    }
  };

  client.channelHandlers.set(channel, handler);
  await subscribe(channel, handler);

  sendEvent(client.ws, { event: 'joined', groupId });
}

async function handleLeave(client: ConnectedClient, groupId: string): Promise<void> {
  const channel = channelForGroup(groupId);
  const handler = client.channelHandlers.get(channel);
  if (handler) {
    await unsubscribe(channel, handler);
    client.channelHandlers.delete(channel);
  }
  client.joinedGroups.delete(groupId);
  sendEvent(client.ws, { event: 'left', groupId });
}

async function handleSendMessage(
  db: Sql,
  client: ConnectedClient,
  event: { groupId: string; content: string; type: 'text' | 'media'; mediaUrl?: string | undefined; mediaType?: string | undefined },
): Promise<void> {
  if (!client.joinedGroups.has(event.groupId)) {
    sendError(client.ws, 'NOT_JOINED', 'Must join group before sending messages');
    return;
  }

  const muted = await isMuted(db, event.groupId, client.userId);
  if (muted) {
    sendError(client.ws, 'MUTED', 'You are muted in this group');
    return;
  }

  const input: {
    groupId: string;
    senderId: string;
    type: 'text' | 'media';
    content: string;
    mediaUrl?: string;
    mediaType?: string;
  } = {
    groupId: event.groupId,
    senderId: client.userId,
    type: event.type,
    content: event.content,
  };
  if (event.mediaUrl !== undefined) input.mediaUrl = event.mediaUrl;
  if (event.mediaType !== undefined) input.mediaType = event.mediaType;

  const message = await sendMessage(db, input);

  const outgoing = buildMessageNewPayload(message);

  // Send back to sender directly
  sendEvent(client.ws, outgoing);

  // Publish to channel for other subscribers
  const channel = channelForGroup(event.groupId);
  await publish(channel, { ...outgoing, _senderId: client.userId });
}

async function handleEditMessage(
  db: Sql,
  client: ConnectedClient,
  event: { messageId: string; content: string },
): Promise<void> {
  const existing = await getMessageById(db, event.messageId);
  if (!existing) {
    sendError(client.ws, 'NOT_FOUND', 'Message not found');
    return;
  }
  if (existing.sender_id !== client.userId) {
    sendError(client.ws, 'FORBIDDEN', 'Cannot edit another user\'s message');
    return;
  }

  const updated = await editMessage(db, event.messageId, event.content);

  const outgoing = {
    event: 'message:edited',
    messageId: updated.id,
    content: updated.content,
    editedAt: updated.edited_at,
  };

  // Send back to sender
  sendEvent(client.ws, outgoing);

  // Publish to group channel
  const channel = channelForGroup(existing.group_id);
  await publish(channel, { ...outgoing, _senderId: client.userId });
}

async function handleDeleteMessage(
  db: Sql,
  client: ConnectedClient,
  event: { messageId: string },
): Promise<void> {
  const existing = await getMessageById(db, event.messageId);
  if (!existing) {
    sendError(client.ws, 'NOT_FOUND', 'Message not found');
    return;
  }
  if (existing.sender_id !== client.userId) {
    sendError(client.ws, 'FORBIDDEN', 'Cannot delete another user\'s message');
    return;
  }

  await deleteMessage(db, event.messageId);

  const outgoing = {
    event: 'message:deleted',
    messageId: event.messageId,
  };

  sendEvent(client.ws, outgoing);

  const channel = channelForGroup(existing.group_id);
  await publish(channel, { ...outgoing, _senderId: client.userId });
}

async function handleTyping(
  client: ConnectedClient,
  groupId: string,
  isTyping: boolean,
): Promise<void> {
  if (!client.joinedGroups.has(groupId)) return;

  const channel = channelForGroup(groupId);
  await publish(channel, {
    event: 'typing',
    groupId,
    userId: client.userId,
    isTyping,
    _senderId: client.userId,
  });
}

async function handleRead(
  db: Sql,
  client: ConnectedClient,
  event: { groupId: string; lastReadMessageId: string },
): Promise<void> {
  if (!client.joinedGroups.has(event.groupId)) {
    sendError(client.ws, 'NOT_JOINED', 'Must join group first');
    return;
  }

  await markRead(db, event.groupId, client.userId, event.lastReadMessageId);

  const outgoing = {
    event: 'read:update',
    groupId: event.groupId,
    userId: client.userId,
    lastReadMessageId: event.lastReadMessageId,
  };

  const channel = channelForGroup(event.groupId);
  await publish(channel, { ...outgoing, _senderId: client.userId });
}

async function handleReactionAdd(
  db: Sql,
  client: ConnectedClient,
  event: { messageId: string; emoji: string },
): Promise<void> {
  const existing = await getMessageById(db, event.messageId);
  if (!existing) {
    sendError(client.ws, 'NOT_FOUND', 'Message not found');
    return;
  }

  if (!client.joinedGroups.has(existing.group_id)) {
    sendError(client.ws, 'NOT_JOINED', 'Must join group first');
    return;
  }

  await addReaction(db, event.messageId, client.userId, event.emoji);

  const outgoing = {
    event: 'reaction:added',
    messageId: event.messageId,
    userId: client.userId,
    emoji: event.emoji,
  };

  sendEvent(client.ws, outgoing);

  const channel = channelForGroup(existing.group_id);
  await publish(channel, { ...outgoing, _senderId: client.userId });
}

async function handleReactionRemove(
  db: Sql,
  client: ConnectedClient,
  event: { messageId: string; emoji: string },
): Promise<void> {
  const existing = await getMessageById(db, event.messageId);
  if (!existing) {
    sendError(client.ws, 'NOT_FOUND', 'Message not found');
    return;
  }

  if (!client.joinedGroups.has(existing.group_id)) {
    sendError(client.ws, 'NOT_JOINED', 'Must join group first');
    return;
  }

  await removeReaction(db, event.messageId, client.userId, event.emoji);

  const outgoing = {
    event: 'reaction:removed',
    messageId: event.messageId,
    userId: client.userId,
    emoji: event.emoji,
  };

  sendEvent(client.ws, outgoing);

  const channel = channelForGroup(existing.group_id);
  await publish(channel, { ...outgoing, _senderId: client.userId });
}

async function handleSync(
  db: Sql,
  client: ConnectedClient,
  event: { groups: Array<{ groupId: string; lastMessageId: string }> },
): Promise<void> {
  for (const group of event.groups) {
    const member = await isMember(db, group.groupId, client.userId);
    if (!member) continue;

    // Get the timestamp of the last known message
    const cursorMsg = await getMessageById(db, group.lastMessageId);
    if (!cursorMsg) {
      sendEvent(client.ws, {
        event: 'sync:response',
        groupId: group.groupId,
        messages: [],
        hasMore: false,
      });
      continue;
    }

    // Fetch messages after the cursor (newer messages)
    const rows = await db<ChatMessage[]>`
      SELECT * FROM chat_messages
      WHERE group_id = ${group.groupId}
        AND deleted_at IS NULL
        AND created_at > ${cursorMsg.created_at}
      ORDER BY created_at ASC
      LIMIT 51
    `;

    const hasMore = rows.length > 50;
    const messages = hasMore ? rows.slice(0, 50) : rows;

    sendEvent(client.ws, {
      event: 'sync:response',
      groupId: group.groupId,
      messages,
      hasMore,
    });
  }
}

function buildMessageNewPayload(message: ChatMessage): Record<string, unknown> {
  return {
    event: 'message:new',
    message: {
      id: message.id,
      group_id: message.group_id,
      sender_id: message.sender_id,
      type: message.type,
      content: message.content,
      media_url: message.media_url,
      media_type: message.media_type,
      created_at: message.created_at,
    },
  };
}
