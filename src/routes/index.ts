import type { FastifyInstance } from 'fastify';
import adminAuthRoutes from './admin/auth/index';
import organizationRoutes from './admin/organizations/index';
import userRoutes from './admin/users/index';

export default async function apiRoutes(app: FastifyInstance): Promise<void> {
  // Admin auth routes: /api/v1/admin/auth/*
  await app.register(adminAuthRoutes, { prefix: '/admin/auth' });

  // Admin organization routes: /api/v1/admin/organizations/*
  await app.register(organizationRoutes, { prefix: '/admin/organizations' });

  // Admin user routes: /api/v1/admin/users/*
  await app.register(userRoutes, { prefix: '/admin/users' });
}
