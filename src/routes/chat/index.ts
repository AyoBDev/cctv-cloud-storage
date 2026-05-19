import type { FastifyInstance } from 'fastify';
import chatGroupRoutes from './groups';

export default async function chatRoutes(app: FastifyInstance): Promise<void> {
  await app.register(chatGroupRoutes, { prefix: '/groups' });
}
