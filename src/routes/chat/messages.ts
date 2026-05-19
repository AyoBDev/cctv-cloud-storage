import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '@middleware/require-user';
import { AppError } from '@utils/errors';
import { getGroupById, isMember, isMuted, getMemberRole } from '@services/chat.service';
import {
  sendMessage,
  getMessages,
  getMessageById,
  editMessage,
  deleteMessage,
  addReaction,
  removeReaction,
  markRead,
} from '@services/chat-message.service';

const groupIdParamsSchema = z.object({
  groupId: z.string().uuid(),
});

const messageParamsSchema = z.object({
  groupId: z.string().uuid(),
  messageId: z.string().uuid(),
});

const reactionParamsSchema = z.object({
  groupId: z.string().uuid(),
  messageId: z.string().uuid(),
  emoji: z.string().min(1).max(32),
});

const getMessagesQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = v ? parseInt(v, 10) : 50;
      return Math.min(Math.max(n, 1), 100);
    }),
  cursor: z.string().uuid().optional(),
});

const sendMessageBodySchema = z.object({
  content: z.string().min(1).max(5000),
  type: z.enum(['text', 'media']).default('text'),
  mediaUrl: z.string().url().optional(),
  mediaType: z.string().max(50).optional(),
});

const editMessageBodySchema = z.object({
  content: z.string().min(1).max(5000),
});

const reactionBodySchema = z.object({
  emoji: z.string().min(1).max(32),
});

const markReadBodySchema = z.object({
  lastReadMessageId: z.string().uuid(),
});

export default async function chatMessageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireUser);

  // GET /:groupId/messages — Paginated history
  app.get('/:groupId/messages', async (request, reply) => {
    const params = groupIdParamsSchema.parse(request.params);
    const query = getMessagesQuerySchema.parse(request.query);

    const group = await getGroupById(app.db, params.groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const memberCheck = await isMember(app.db, params.groupId, request.user.sub);
    if (!memberCheck) throw AppError.forbidden('You are not a member of this group');

    const result = await getMessages(app.db, params.groupId, query.limit, query.cursor);
    return reply.code(200).send(result);
  });

  // POST /:groupId/messages — Send message
  app.post('/:groupId/messages', async (request, reply) => {
    const params = groupIdParamsSchema.parse(request.params);
    const body = sendMessageBodySchema.parse(request.body);

    const group = await getGroupById(app.db, params.groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const memberCheck = await isMember(app.db, params.groupId, request.user.sub);
    if (!memberCheck) throw AppError.forbidden('You are not a member of this group');

    const muted = await isMuted(app.db, params.groupId, request.user.sub);
    if (muted) throw AppError.forbidden('You are muted in this group');

    const input: {
      groupId: string;
      senderId: string;
      type: 'text' | 'media' | 'system';
      content: string;
      mediaUrl?: string;
      mediaType?: string;
    } = {
      groupId: params.groupId,
      senderId: request.user.sub,
      type: body.type,
      content: body.content,
    };
    if (body.mediaUrl !== undefined) input.mediaUrl = body.mediaUrl;
    if (body.mediaType !== undefined) input.mediaType = body.mediaType;

    const message = await sendMessage(app.db, input);
    return reply.code(201).send(message);
  });

  // PATCH /:groupId/messages/:messageId — Edit message
  app.patch('/:groupId/messages/:messageId', async (request, reply) => {
    const params = messageParamsSchema.parse(request.params);
    const body = editMessageBodySchema.parse(request.body);

    const group = await getGroupById(app.db, params.groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const message = await getMessageById(app.db, params.messageId);
    if (!message) throw AppError.notFound('Message not found');

    if (message.sender_id !== request.user.sub) {
      throw AppError.forbidden('Only the sender can edit this message');
    }

    const updated = await editMessage(app.db, params.messageId, body.content);
    return reply.code(200).send(updated);
  });

  // DELETE /:groupId/messages/:messageId — Soft-delete message
  app.delete('/:groupId/messages/:messageId', async (request, reply) => {
    const params = messageParamsSchema.parse(request.params);

    const group = await getGroupById(app.db, params.groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const message = await getMessageById(app.db, params.messageId);
    if (!message) throw AppError.notFound('Message not found');

    const isSender = message.sender_id === request.user.sub;
    const role = await getMemberRole(app.db, params.groupId, request.user.sub);
    const isOwner = role === 'owner';
    const isOrgAdmin = request.user.role === 'org_admin';

    if (!isSender && !isOwner && !isOrgAdmin) {
      throw AppError.forbidden('You do not have permission to delete this message');
    }

    await deleteMessage(app.db, params.messageId);
    return reply.code(200).send({ deleted: true });
  });

  // POST /:groupId/messages/:messageId/reactions — Add reaction
  app.post('/:groupId/messages/:messageId/reactions', async (request, reply) => {
    const params = messageParamsSchema.parse(request.params);
    const body = reactionBodySchema.parse(request.body);

    const group = await getGroupById(app.db, params.groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const memberCheck = await isMember(app.db, params.groupId, request.user.sub);
    if (!memberCheck) throw AppError.forbidden('You are not a member of this group');

    const message = await getMessageById(app.db, params.messageId);
    if (!message) throw AppError.notFound('Message not found');

    await addReaction(app.db, params.messageId, request.user.sub, body.emoji);
    return reply.code(201).send({ added: true });
  });

  // DELETE /:groupId/messages/:messageId/reactions/:emoji — Remove own reaction
  app.delete('/:groupId/messages/:messageId/reactions/:emoji', async (request, reply) => {
    const params = reactionParamsSchema.parse(request.params);
    const decodedEmoji = decodeURIComponent(params.emoji);

    const group = await getGroupById(app.db, params.groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const memberCheck = await isMember(app.db, params.groupId, request.user.sub);
    if (!memberCheck) throw AppError.forbidden('You are not a member of this group');

    await removeReaction(app.db, params.messageId, request.user.sub, decodedEmoji);
    return reply.code(200).send({ removed: true });
  });

  // POST /:groupId/read — Mark read
  app.post('/:groupId/read', async (request, reply) => {
    const params = groupIdParamsSchema.parse(request.params);
    const body = markReadBodySchema.parse(request.body);

    const group = await getGroupById(app.db, params.groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const memberCheck = await isMember(app.db, params.groupId, request.user.sub);
    if (!memberCheck) throw AppError.forbidden('You are not a member of this group');

    await markRead(app.db, params.groupId, request.user.sub, body.lastReadMessageId);
    return reply.code(200).send({ success: true });
  });
}
