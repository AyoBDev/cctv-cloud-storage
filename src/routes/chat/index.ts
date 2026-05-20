import type { FastifyInstance } from 'fastify';
import chatGroupRoutes from './groups';
import chatMessageRoutes from './messages';
import chatReportRoutes from './reports';

export default async function chatRoutes(app: FastifyInstance): Promise<void> {
  await app.register(chatGroupRoutes, { prefix: '/groups' });
  await app.register(chatMessageRoutes, { prefix: '/groups' });
  await app.register(chatReportRoutes);
}
