import type { FastifyInstance } from 'fastify';
import adminAuthRoutes from './admin/auth/index';
import organizationRoutes from './admin/organizations/index';
import userRoutes from './admin/users/index';
import adminCameraRoutes from './admin/cameras/index';
import authRoutes from './auth/index';
import orgUserRoutes from './org/users/index';
import cameraRoutes from './cameras/index';

export default async function apiRoutes(app: FastifyInstance): Promise<void> {
  // Admin auth routes: /api/v1/admin/auth/*
  await app.register(adminAuthRoutes, { prefix: '/admin/auth' });

  // Admin organization routes: /api/v1/admin/organizations/*
  await app.register(organizationRoutes, { prefix: '/admin/organizations' });

  // Admin user routes: /api/v1/admin/users/*
  await app.register(userRoutes, { prefix: '/admin/users' });

  // Admin camera routes: /api/v1/admin/cameras/*
  await app.register(adminCameraRoutes, { prefix: '/admin/cameras' });

  // Org user auth routes: /api/v1/auth/*
  await app.register(authRoutes, { prefix: '/auth' });

  // Org admin user management routes: /api/v1/org/users/*
  await app.register(orgUserRoutes, { prefix: '/org/users' });

  // Camera routes: /api/v1/cameras/*
  await app.register(cameraRoutes, { prefix: '/cameras' });
}
