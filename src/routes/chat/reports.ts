import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '@middleware/require-user';
import { requireOrgAdmin } from '@middleware/require-org-admin';
import { AppError } from '@utils/errors';
import { isMember, getGroupById } from '@services/chat.service';

const createReportParamsSchema = z.object({
  groupId: z.string().uuid(),
});

const createReportBodySchema = z.object({
  reportedUser: z.string().uuid(),
  messageId: z.string().uuid().optional(),
  reason: z.string().min(1).max(1000),
});

const updateReportParamsSchema = z.object({
  reportId: z.string().uuid(),
});

const updateReportBodySchema = z.object({
  status: z.enum(['reviewed', 'dismissed']),
});

interface ChatReport {
  id: string;
  group_id: string;
  reported_by: string;
  reported_user: string;
  message_id: string | null;
  reason: string;
  status: string;
  created_at: Date;
}

export default async function chatReportRoutes(app: FastifyInstance): Promise<void> {
  // POST /groups/:groupId/reports — Create a report (requireUser)
  app.post('/groups/:groupId/reports', { onRequest: [requireUser] }, async (request, reply) => {
    const params = createReportParamsSchema.parse(request.params);
    const body = createReportBodySchema.parse(request.body);

    const group = await getGroupById(app.db, params.groupId, request.user.org_id!);
    if (!group) throw AppError.notFound('Group not found');

    const memberCheck = await isMember(app.db, params.groupId, request.user.sub);
    if (!memberCheck) throw AppError.forbidden('You are not a member of this group');

    const input: {
      group_id: string;
      reported_by: string;
      reported_user: string;
      message_id?: string;
      reason: string;
    } = {
      group_id: params.groupId,
      reported_by: request.user.sub,
      reported_user: body.reportedUser,
      reason: body.reason,
    };
    if (body.messageId !== undefined) input.message_id = body.messageId;

    const rows = await app.db<ChatReport[]>`
      INSERT INTO chat_reports (group_id, reported_by, reported_user, message_id, reason)
      VALUES (${input.group_id}, ${input.reported_by}, ${input.reported_user}, ${input.message_id ?? null}, ${input.reason})
      RETURNING *
    `;

    const report = rows[0];
    if (!report) throw new Error('Insert returned no rows');

    return reply.code(201).send(report);
  });

  // GET /reports — List reports for org (requireOrgAdmin)
  app.get('/reports', { onRequest: [requireOrgAdmin] }, async (request, reply) => {
    const rows = await app.db<ChatReport[]>`
      SELECT r.*
      FROM chat_reports r
      INNER JOIN chat_groups g ON g.id = r.group_id
      WHERE g.org_id = ${request.user.org_id!}
      ORDER BY r.created_at DESC
    `;

    return reply.code(200).send({ data: rows });
  });

  // PATCH /reports/:reportId — Update report status (requireOrgAdmin)
  app.patch('/reports/:reportId', { onRequest: [requireOrgAdmin] }, async (request, reply) => {
    const params = updateReportParamsSchema.parse(request.params);
    const body = updateReportBodySchema.parse(request.body);

    const rows = await app.db<ChatReport[]>`
      UPDATE chat_reports
      SET status = ${body.status}
      WHERE id = ${params.reportId}
        AND group_id IN (
          SELECT id FROM chat_groups WHERE org_id = ${request.user.org_id!}
        )
      RETURNING *
    `;

    const report = rows[0];
    if (!report) throw AppError.notFound('Report not found');

    return reply.code(200).send(report);
  });
}
