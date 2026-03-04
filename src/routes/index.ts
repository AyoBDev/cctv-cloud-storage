import type { FastifyInstance } from 'fastify';
import adminAuthRoutes from './admin/auth/index';

export default async function apiRoutes(app: FastifyInstance): Promise<void> {
  // Admin auth routes: /api/v1/admin/auth/*
  await app.register(adminAuthRoutes, { prefix: '/admin/auth' });
}
