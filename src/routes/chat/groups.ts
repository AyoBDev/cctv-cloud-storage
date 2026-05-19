import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '@middleware/require-user';
import { AppError } from '@utils/errors';
import {
  createGroup,
  listGroupsForUser,
  getGroupById,
  updateGroup,
  deleteGroup,
  isMember,
  getMemberRole,
  addMembers,
  removeMember,
  muteMember,
  unmuteMember,
  getGroupMembers,
} from '@services/chat.service';

const groupIdParamsSchema = z.object({
  groupId: z.string().uuid(),
});

const memberParamsSchema = z.object({
  groupId: z.string().uuid(),
  userId: z.string().uuid(),
});

const createGroupBodySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

const updateGroupBodySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

const addMembersBodySchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(50),
});

const muteBodySchema = z.object({
  duration: z.number().int().positive().max(525600),
});

export default async function chatGroupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireUser);

  // POST /api/v1/chat/groups
  app.post('/', async (request, reply) => {
    const body = createGroupBodySchema.parse(request.body);
    const input: { name: string; description?: string; orgId: string; createdBy: string } = {
      name: body.name,
      orgId: request.user.org_id!,
      createdBy: request.user.sub,
    };
    if (body.description !== undefined) input.description = body.description;
    const group = await createGroup(app.db, input);
    return reply.code(201).send(group);
  });

  // GET /api/v1/chat/groups
  app.get('/', async (request, reply) => {
    const groups = await listGroupsForUser(app.db, request.user.sub, request.user.org_id!);
    return reply.code(200).send(groups);
  });

  // GET /api/v1/chat/groups/:groupId
  app.get('/:groupId', async (request, reply) => {
    const params = groupIdParamsSchema.parse(request.params);
    const group = await getGroupById(app.db, params.groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const memberCheck = await isMember(app.db, params.groupId, request.user.sub);
    if (!memberCheck) throw AppError.forbidden('You are not a member of this group');

    const members = await getGroupMembers(app.db, params.groupId);
    return reply.code(200).send({ ...group, members });
  });

  // PATCH /api/v1/chat/groups/:groupId
  app.patch('/:groupId', async (request, reply) => {
    const params = groupIdParamsSchema.parse(request.params);
    const body = updateGroupBodySchema.parse(request.body);

    const group = await getGroupById(app.db, params.groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    // Only owner or org_admin can update
    const role = await getMemberRole(app.db, params.groupId, request.user.sub);
    if (role !== 'owner' && request.user.role !== 'org_admin') {
      throw AppError.forbidden('Only group owner or org admin can update the group');
    }

    const input: { name?: string; description?: string } = {};
    if (body.name !== undefined) input.name = body.name;
    if (body.description !== undefined) input.description = body.description;

    const updated = await updateGroup(app.db, params.groupId, input);
    return reply.code(200).send(updated);
  });

  // DELETE /api/v1/chat/groups/:groupId
  app.delete('/:groupId', async (request, reply) => {
    const params = groupIdParamsSchema.parse(request.params);

    const group = await getGroupById(app.db, params.groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    // Only owner or org_admin can delete
    const role = await getMemberRole(app.db, params.groupId, request.user.sub);
    if (role !== 'owner' && request.user.role !== 'org_admin') {
      throw AppError.forbidden('Only group owner or org admin can delete the group');
    }

    await deleteGroup(app.db, params.groupId);
    return reply.code(204).send();
  });

  // POST /api/v1/chat/groups/:groupId/members
  app.post('/:groupId/members', async (request, reply) => {
    const params = groupIdParamsSchema.parse(request.params);
    const body = addMembersBodySchema.parse(request.body);

    const group = await getGroupById(app.db, params.groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const memberCheck = await isMember(app.db, params.groupId, request.user.sub);
    if (!memberCheck) throw AppError.forbidden('You are not a member of this group');

    const count = await addMembers(app.db, params.groupId, body.userIds, request.user.org_id!);
    return reply.code(200).send({ added: count });
  });

  // DELETE /api/v1/chat/groups/:groupId/members/:userId
  app.delete('/:groupId/members/:userId', async (request, reply) => {
    const params = memberParamsSchema.parse(request.params);

    const group = await getGroupById(app.db, params.groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const isSelfLeave = params.userId === request.user.sub;

    if (!isSelfLeave) {
      // Only owner or org_admin can remove others
      const role = await getMemberRole(app.db, params.groupId, request.user.sub);
      if (role !== 'owner' && request.user.role !== 'org_admin') {
        throw AppError.forbidden('Only group owner or org admin can remove members');
      }
    }

    await removeMember(app.db, params.groupId, params.userId);
    return reply.code(204).send();
  });

  // PATCH /api/v1/chat/groups/:groupId/members/:userId/mute
  app.patch('/:groupId/members/:userId/mute', async (request, reply) => {
    const params = memberParamsSchema.parse(request.params);
    const body = muteBodySchema.parse(request.body);

    const group = await getGroupById(app.db, params.groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    // Only owner or org_admin can mute
    const role = await getMemberRole(app.db, params.groupId, request.user.sub);
    if (role !== 'owner' && request.user.role !== 'org_admin') {
      throw AppError.forbidden('Only group owner or org admin can mute members');
    }

    const mutedUntil = new Date(Date.now() + body.duration * 60 * 1000);
    await muteMember(app.db, params.groupId, params.userId, mutedUntil);
    return reply.code(200).send({ muted_until: mutedUntil.toISOString() });
  });

  // PATCH /api/v1/chat/groups/:groupId/members/:userId/unmute
  app.patch('/:groupId/members/:userId/unmute', async (request, reply) => {
    const params = memberParamsSchema.parse(request.params);

    const group = await getGroupById(app.db, params.groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    // Only owner or org_admin can unmute
    const role = await getMemberRole(app.db, params.groupId, request.user.sub);
    if (role !== 'owner' && request.user.role !== 'org_admin') {
      throw AppError.forbidden('Only group owner or org admin can unmute members');
    }

    await unmuteMember(app.db, params.groupId, params.userId);
    return reply.code(200).send({ muted_until: null });
  });
}
