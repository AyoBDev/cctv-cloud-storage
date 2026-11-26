import type { FastifyInstance } from 'fastify';
import adminAuthRoutes from './admin/auth/index';
import organizationRoutes from './admin/organizations/index';
import userRoutes from './admin/users/index';
import adminCameraRoutes from './admin/cameras/index';
import authRoutes from './auth/index';
import orgUserRoutes from './org/users/index';
import orgFaceDetectionRoutes from './org/face-detection';
import orgSubscriptionRoutes from './org/subscription';
import cameraRoutes from './cameras/index';
import faceProfileRoutes from './face-profiles/index';
import recognitionEventRoutes from './recognition-events/index';
import chatRoutes from './chat/index';
import marketplaceRoutes from './marketplace/index';

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

  // Org face detection routes: /api/v1/org/face-detection/*
  await app.register(orgFaceDetectionRoutes, { prefix: '/org/face-detection' });

  // Org subscription status: /api/v1/org/subscription
  await app.register(orgSubscriptionRoutes, { prefix: '/org/subscription' });

  // Camera routes: /api/v1/cameras/*
  await app.register(cameraRoutes, { prefix: '/cameras' });

  // Face profile routes: /api/v1/face-profiles/*
  await app.register(faceProfileRoutes, { prefix: '/face-profiles' });

  // Recognition event routes: /api/v1/recognition-events/*
  await app.register(recognitionEventRoutes, { prefix: '/recognition-events' });

  // Chat routes: /api/v1/chat/*
  await app.register(chatRoutes, { prefix: '/chat' });

  // AWS Marketplace registration: /api/v1/marketplace/*
  await app.register(marketplaceRoutes, { prefix: '/marketplace' });
}
