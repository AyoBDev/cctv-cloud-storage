import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';
import {
  addViewersToCamera,
  removeViewersFromCamera,
  replaceViewersForCamera,
  listViewersForCamera,
  addCamerasToViewer,
  removeCamerasFromViewer,
  replaceCamerasForViewer,
  listCamerasForViewer,
  isViewerAssigned,
} from '../../src/services/assignment.service';

describe('Assignment Service', () => {
  let app: FastifyInstance;
  let orgId: string;
  let orgAdminId: string;
  let viewerId: string;
  let cameraId: string;
  let orgAdminAccessToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'assign-svc');
    orgId = org.orgId;
    orgAdminAccessToken = org.orgAdminAccessToken;

    // Get org admin user ID from token
    const adminRows = await app.db<[{ id: string }]>`
      SELECT id FROM users WHERE email = ${org.orgAdminEmail}
    `;
    orgAdminId = adminRows[0]!.id;

    // Create a viewer user
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { email: `viewer-assign-svc-${Date.now()}@example.com`, password: 'password123!' },
    });
    viewerId = viewerRes.json<{ id: string }>().id;

    // Create a camera
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Assign Test Camera' },
    });
    cameraId = camRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('addViewersToCamera', () => {
    it('assigns a viewer to a camera and returns count', async () => {
      const result = await addViewersToCamera(app.db, orgId, cameraId, [viewerId], orgAdminId);
      expect(result).toBe(1);
    });

    it('is idempotent — adding same viewer again returns 0', async () => {
      const result = await addViewersToCamera(app.db, orgId, cameraId, [viewerId], orgAdminId);
      expect(result).toBe(0);
    });
  });

  describe('listViewersForCamera', () => {
    it('returns assigned viewers', async () => {
      const viewers = await listViewersForCamera(app.db, orgId, cameraId);
      expect(viewers).toHaveLength(1);
      expect(viewers[0]).toMatchObject({
        id: viewerId,
        email: expect.any(String),
      });
      expect(viewers[0]).toHaveProperty('assigned_at');
    });
  });

  describe('isViewerAssigned', () => {
    it('returns true when assigned', async () => {
      const result = await isViewerAssigned(app.db, cameraId, viewerId);
      expect(result).toBe(true);
    });

    it('returns false when not assigned', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const result = await isViewerAssigned(app.db, cameraId, fakeId);
      expect(result).toBe(false);
    });
  });

  describe('removeViewersFromCamera', () => {
    it('removes a viewer and returns count', async () => {
      const result = await removeViewersFromCamera(app.db, orgId, cameraId, [viewerId]);
      expect(result).toBe(1);
    });

    it('removing non-existent assignment returns 0', async () => {
      const result = await removeViewersFromCamera(app.db, orgId, cameraId, [viewerId]);
      expect(result).toBe(0);
    });
  });

  describe('replaceViewersForCamera', () => {
    it('replaces all viewers', async () => {
      // First assign viewer
      await addViewersToCamera(app.db, orgId, cameraId, [viewerId], orgAdminId);

      // Replace with only the original viewer
      const result = await replaceViewersForCamera(app.db, orgId, cameraId, [viewerId], orgAdminId);
      expect(result).toBe(1);

      const viewers = await listViewersForCamera(app.db, orgId, cameraId);
      expect(viewers).toHaveLength(1);
      expect(viewers[0]!.id).toBe(viewerId);
    });
  });

  describe('addCamerasToViewer', () => {
    it('assigns a camera to a viewer and returns count', async () => {
      // Clean slate
      await removeViewersFromCamera(app.db, orgId, cameraId, [viewerId]);

      const result = await addCamerasToViewer(app.db, orgId, viewerId, [cameraId], orgAdminId);
      expect(result).toBe(1);
    });
  });

  describe('listCamerasForViewer', () => {
    it('returns assigned cameras', async () => {
      const cameras = await listCamerasForViewer(app.db, orgId, viewerId);
      expect(cameras).toHaveLength(1);
      expect(cameras[0]).toMatchObject({
        id: cameraId,
        name: 'Assign Test Camera',
      });
      expect(cameras[0]).toHaveProperty('assigned_at');
    });
  });

  describe('removeCamerasFromViewer', () => {
    it('removes a camera and returns count', async () => {
      const result = await removeCamerasFromViewer(app.db, orgId, viewerId, [cameraId]);
      expect(result).toBe(1);
    });
  });

  describe('replaceCamerasForViewer', () => {
    it('replaces all cameras for a viewer', async () => {
      const result = await replaceCamerasForViewer(app.db, orgId, viewerId, [cameraId], orgAdminId);
      expect(result).toBe(1);

      const cameras = await listCamerasForViewer(app.db, orgId, viewerId);
      expect(cameras).toHaveLength(1);
    });
  });
});
