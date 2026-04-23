# Camera-to-User Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow org admins to assign specific cameras to viewers so they only see cameras explicitly granted to them (whitelist model).

**Architecture:** Join table `camera_assignments(camera_id, user_id)` with composite PK. 8 new CRUD endpoints across camera-centric and user-centric directions. Existing camera list/detail/credentials endpoints modified to filter by assignment for viewers. Org admins always see all cameras.

**Tech Stack:** Fastify, PostgreSQL (postgres.js), Redis (ioredis), Zod, Jest + Supertest

---

### Task 1: Database Migration

**Files:**
- Create: `src/db/migrations/005_camera_assignments.ts`

- [ ] **Step 1: Create the migration file**

```typescript
import type { MigrationBuilder } from 'node-pg-migrate/dist/bundle/index';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('camera_assignments', {
    camera_id: {
      type: 'uuid',
      notNull: true,
      references: 'cameras(id)',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    assigned_by: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
    },
    assigned_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.addConstraint('camera_assignments', 'camera_assignments_pkey', {
    primaryKey: ['camera_id', 'user_id'],
  });

  pgm.createIndex('camera_assignments', 'user_id', {
    name: 'idx_camera_assignments_user',
  });

  pgm.createIndex('camera_assignments', 'camera_id', {
    name: 'idx_camera_assignments_camera',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('camera_assignments');
}
```

- [ ] **Step 2: Run migration locally**

Run: `npm run migrate`
Expected: Migration 005 applies successfully, `camera_assignments` table created.

- [ ] **Step 3: Verify table exists**

Run: `psql -d cctv_test -c "\d camera_assignments"`
Expected: Table with `camera_id`, `user_id`, `assigned_by`, `assigned_at` columns, PK on `(camera_id, user_id)`.

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/005_camera_assignments.ts
git commit -m "feat: add camera_assignments migration"
```

---

### Task 2: Assignment Service

**Files:**
- Create: `src/services/assignment.service.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assignments/assignment-service.test.ts`:

```typescript
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

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'assign-svc');
    orgId = org.orgId;

    // Get org admin user ID from token
    const adminRows = await app.db<[{ id: string }]>`
      SELECT id FROM users WHERE email = ${org.orgAdminEmail}
    `;
    orgAdminId = adminRows[0]!.id;

    // Create a viewer user
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${org.orgAdminAccessToken}` },
      payload: { email: `viewer-assign-svc-${Date.now()}@example.com`, password: 'password123!' },
    });
    viewerId = viewerRes.json<{ id: string }>().id;

    // Create a camera
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${org.orgAdminAccessToken}` },
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

      // Create second viewer
      const v2Res = await app.inject({
        method: 'POST',
        url: '/api/v1/org/users',
        headers: { authorization: `Bearer ${(await createOrgAndLogin(app, await loginAsSuperAdmin(app), 'assign-svc-replace')).orgAdminAccessToken}` },
        payload: { email: `v2-${Date.now()}@example.com`, password: 'password123!' },
      });

      // For simplicity, replace with only the original viewer
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/assignments/assignment-service.test.ts`
Expected: FAIL — cannot resolve `../../src/services/assignment.service`

- [ ] **Step 3: Write the assignment service**

Create `src/services/assignment.service.ts`:

```typescript
import type { Sql } from 'postgres';
import { AppError } from '@utils/errors';

export interface AssignmentViewer {
  id: string;
  email: string;
  name?: string;
  assigned_at: Date;
}

export interface AssignmentCamera {
  id: string;
  name: string;
  slug: string;
  status: string;
  assigned_at: Date;
}

/**
 * Validate that all user IDs exist, belong to the same org, and are viewers.
 * Returns the count of valid IDs. Throws if any are invalid.
 */
async function validateViewerIds(db: Sql, orgId: string, userIds: string[]): Promise<void> {
  const rows = await db<Array<{ id: string; role: string }>>`
    SELECT id, role FROM users
    WHERE id = ANY(${userIds}) AND org_id = ${orgId} AND is_active = true
  `;

  if (rows.length !== userIds.length) {
    throw AppError.badRequest('One or more user IDs are invalid or do not belong to this organization');
  }

  const nonViewers = rows.filter((r) => r.role !== 'viewer');
  if (nonViewers.length > 0) {
    throw AppError.badRequest('Cannot assign cameras to org admins — they already have access to all cameras');
  }
}

/**
 * Validate that all camera IDs exist and belong to the same org.
 */
async function validateCameraIds(db: Sql, orgId: string, cameraIds: string[]): Promise<void> {
  const rows = await db<Array<{ id: string }>>`
    SELECT id FROM cameras
    WHERE id = ANY(${cameraIds}) AND org_id = ${orgId} AND is_active = true
  `;

  if (rows.length !== cameraIds.length) {
    throw AppError.badRequest('One or more camera IDs are invalid or do not belong to this organization');
  }
}

/**
 * Verify a camera exists and belongs to the org. Throws 404 if not found.
 */
async function verifyCameraOrg(db: Sql, orgId: string, cameraId: string): Promise<void> {
  const rows = await db<Array<{ id: string }>>`
    SELECT id FROM cameras WHERE id = ${cameraId} AND org_id = ${orgId} AND is_active = true
  `;
  if (rows.length === 0) {
    throw AppError.notFound('Camera not found');
  }
}

/**
 * Verify a user exists, belongs to the org, and is a viewer. Throws if not.
 */
async function verifyViewerOrg(db: Sql, orgId: string, userId: string): Promise<void> {
  const rows = await db<Array<{ id: string; role: string }>>`
    SELECT id, role FROM users WHERE id = ${userId} AND org_id = ${orgId} AND is_active = true
  `;
  if (rows.length === 0) {
    throw AppError.notFound('User not found');
  }
  if (rows[0]!.role !== 'viewer') {
    throw AppError.badRequest('User is not a viewer');
  }
}

// ── Camera-centric operations ──

export async function addViewersToCamera(
  db: Sql,
  orgId: string,
  cameraId: string,
  userIds: string[],
  assignedBy: string,
): Promise<number> {
  await verifyCameraOrg(db, orgId, cameraId);
  await validateViewerIds(db, orgId, userIds);

  const values = userIds.map((uid) => ({ camera_id: cameraId, user_id: uid, assigned_by: assignedBy }));

  const rows = await db`
    INSERT INTO camera_assignments ${db(values, 'camera_id', 'user_id', 'assigned_by')}
    ON CONFLICT (camera_id, user_id) DO NOTHING
    RETURNING camera_id
  `;

  return rows.length;
}

export async function removeViewersFromCamera(
  db: Sql,
  orgId: string,
  cameraId: string,
  userIds: string[],
): Promise<number> {
  await verifyCameraOrg(db, orgId, cameraId);

  const rows = await db`
    DELETE FROM camera_assignments
    WHERE camera_id = ${cameraId} AND user_id = ANY(${userIds})
    RETURNING camera_id
  `;

  return rows.length;
}

export async function replaceViewersForCamera(
  db: Sql,
  orgId: string,
  cameraId: string,
  userIds: string[],
  assignedBy: string,
): Promise<number> {
  await verifyCameraOrg(db, orgId, cameraId);
  await validateViewerIds(db, orgId, userIds);

  return await db.begin(async (tx) => {
    await tx`DELETE FROM camera_assignments WHERE camera_id = ${cameraId}`;

    if (userIds.length === 0) return 0;

    const values = userIds.map((uid) => ({ camera_id: cameraId, user_id: uid, assigned_by: assignedBy }));

    const rows = await tx`
      INSERT INTO camera_assignments ${tx(values, 'camera_id', 'user_id', 'assigned_by')}
      RETURNING camera_id
    `;

    return rows.length;
  });
}

export async function listViewersForCamera(
  db: Sql,
  orgId: string,
  cameraId: string,
): Promise<AssignmentViewer[]> {
  await verifyCameraOrg(db, orgId, cameraId);

  const rows = await db<AssignmentViewer[]>`
    SELECT u.id, u.email, ca.assigned_at
    FROM camera_assignments ca
    JOIN users u ON u.id = ca.user_id
    WHERE ca.camera_id = ${cameraId}
    ORDER BY ca.assigned_at ASC
  `;

  return rows;
}

// ── User-centric operations ──

export async function addCamerasToViewer(
  db: Sql,
  orgId: string,
  userId: string,
  cameraIds: string[],
  assignedBy: string,
): Promise<number> {
  await verifyViewerOrg(db, orgId, userId);
  await validateCameraIds(db, orgId, cameraIds);

  const values = cameraIds.map((cid) => ({ camera_id: cid, user_id: userId, assigned_by: assignedBy }));

  const rows = await db`
    INSERT INTO camera_assignments ${db(values, 'camera_id', 'user_id', 'assigned_by')}
    ON CONFLICT (camera_id, user_id) DO NOTHING
    RETURNING camera_id
  `;

  return rows.length;
}

export async function removeCamerasFromViewer(
  db: Sql,
  orgId: string,
  userId: string,
  cameraIds: string[],
): Promise<number> {
  await verifyViewerOrg(db, orgId, userId);

  const rows = await db`
    DELETE FROM camera_assignments
    WHERE user_id = ${userId} AND camera_id = ANY(${cameraIds})
    RETURNING camera_id
  `;

  return rows.length;
}

export async function replaceCamerasForViewer(
  db: Sql,
  orgId: string,
  userId: string,
  cameraIds: string[],
  assignedBy: string,
): Promise<number> {
  await verifyViewerOrg(db, orgId, userId);
  await validateCameraIds(db, orgId, cameraIds);

  return await db.begin(async (tx) => {
    await tx`DELETE FROM camera_assignments WHERE user_id = ${userId}`;

    if (cameraIds.length === 0) return 0;

    const values = cameraIds.map((cid) => ({ camera_id: cid, user_id: userId, assigned_by: assignedBy }));

    const rows = await tx`
      INSERT INTO camera_assignments ${tx(values, 'camera_id', 'user_id', 'assigned_by')}
      RETURNING camera_id
    `;

    return rows.length;
  });
}

export async function listCamerasForViewer(
  db: Sql,
  orgId: string,
  userId: string,
): Promise<AssignmentCamera[]> {
  await verifyViewerOrg(db, orgId, userId);

  const rows = await db<AssignmentCamera[]>`
    SELECT c.id, c.name, c.slug, c.status, ca.assigned_at
    FROM camera_assignments ca
    JOIN cameras c ON c.id = ca.camera_id
    WHERE ca.user_id = ${userId} AND c.is_active = true
    ORDER BY ca.assigned_at ASC
  `;

  return rows;
}

// ── Access check ──

export async function isViewerAssigned(
  db: Sql,
  cameraId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db`
    SELECT 1 FROM camera_assignments
    WHERE camera_id = ${cameraId} AND user_id = ${userId}
    LIMIT 1
  `;

  return rows.length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/assignments/assignment-service.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/assignment.service.ts tests/assignments/assignment-service.test.ts
git commit -m "feat: add camera assignment service with tests"
```

---

### Task 3: Camera-Centric Assignment Routes

**Files:**
- Create: `src/routes/cameras/viewers.ts`
- Modify: `src/routes/cameras/index.ts` (register sub-route)
- Create: `tests/assignments/camera-viewers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assignments/camera-viewers.test.ts`:

```typescript
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Camera Viewer Assignments', () => {
  let app: FastifyInstance;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let viewerId: string;
  let cameraId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'cam-viewers');

    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create viewer
    const viewerEmail = `viewer-cv-${Date.now()}@example.com`;
    const viewerPassword = 'password123!';
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerId = viewerRes.json<{ id: string }>().id;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerAccessToken = loginRes.json<{ accessToken: string }>().accessToken;

    // Create camera
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Viewer Route Camera' },
    });
    cameraId = camRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('POST /api/v1/cameras/:cameraId/viewers', () => {
    it('adds viewers to a camera (org admin)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { user_ids: [viewerId] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ assigned: number }>();
      expect(body.assigned).toBe(1);
    });

    it('returns 403 for viewer', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { user_ids: [viewerId] },
      });

      expect(res.statusCode).toBe(403);
    });

    it('is idempotent', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { user_ids: [viewerId] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ assigned: number }>().assigned).toBe(0);
    });

    it('returns 400 for invalid user IDs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { user_ids: ['00000000-0000-0000-0000-000000000000'] },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/cameras/:cameraId/viewers', () => {
    it('lists viewers assigned to a camera', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ viewers: Array<{ id: string; email: string; assigned_at: string }> }>();
      expect(body.viewers).toHaveLength(1);
      expect(body.viewers[0]!.id).toBe(viewerId);
    });
  });

  describe('PUT /api/v1/cameras/:cameraId/viewers', () => {
    it('replaces all viewers for a camera', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { user_ids: [viewerId] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ assigned: number }>().assigned).toBe(1);
    });
  });

  describe('DELETE /api/v1/cameras/:cameraId/viewers', () => {
    it('removes viewers from a camera', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { user_ids: [viewerId] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ removed: number }>().removed).toBe(1);
    });

    it('confirms viewer list is empty after removal', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/viewers`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ viewers: unknown[] }>().viewers).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/assignments/camera-viewers.test.ts`
Expected: FAIL — 404 on `/api/v1/cameras/:cameraId/viewers`

- [ ] **Step 3: Create the viewers route file**

Create `src/routes/cameras/viewers.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrgAdmin } from '@middleware/require-org-admin';
import {
  addViewersToCamera,
  removeViewersFromCamera,
  replaceViewersForCamera,
  listViewersForCamera,
} from '@services/assignment.service';
import { invalidateOrgCameraCache } from '@services/camera.service';

const cameraIdParamsSchema = z.object({
  cameraId: z.string().uuid(),
});

const userIdsBodySchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(100),
});

export default async function cameraViewerRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/cameras/:cameraId/viewers
  app.post(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = cameraIdParamsSchema.parse(request.params);
      const body = userIdsBodySchema.parse(request.body);
      const orgId = request.user.org_id!;

      const assigned = await addViewersToCamera(app.db, orgId, params.cameraId, body.user_ids, request.user.sub);
      await invalidateOrgCameraCache(app.redis, orgId);

      return reply.code(200).send({ assigned });
    },
  );

  // GET /api/v1/cameras/:cameraId/viewers
  app.get(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = cameraIdParamsSchema.parse(request.params);
      const orgId = request.user.org_id!;

      const viewers = await listViewersForCamera(app.db, orgId, params.cameraId);
      return reply.code(200).send({ viewers });
    },
  );

  // PUT /api/v1/cameras/:cameraId/viewers
  app.put(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = cameraIdParamsSchema.parse(request.params);
      const body = userIdsBodySchema.parse(request.body);
      const orgId = request.user.org_id!;

      const assigned = await replaceViewersForCamera(app.db, orgId, params.cameraId, body.user_ids, request.user.sub);
      await invalidateOrgCameraCache(app.redis, orgId);

      return reply.code(200).send({ assigned });
    },
  );

  // DELETE /api/v1/cameras/:cameraId/viewers
  app.delete(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = cameraIdParamsSchema.parse(request.params);
      const body = userIdsBodySchema.parse(request.body);
      const orgId = request.user.org_id!;

      const removed = await removeViewersFromCamera(app.db, orgId, params.cameraId, body.user_ids);
      await invalidateOrgCameraCache(app.redis, orgId);

      return reply.code(200).send({ removed });
    },
  );
}
```

- [ ] **Step 4: Register the sub-route in camera routes**

In `src/routes/cameras/index.ts`, add at the top:

```typescript
import cameraViewerRoutes from './viewers';
```

At the end of the `cameraRoutes` function (before the closing `}`), add:

```typescript
  // Camera viewer assignment routes: /api/v1/cameras/:cameraId/viewers/*
  await app.register(cameraViewerRoutes, { prefix: '/:cameraId/viewers' });
```

- [ ] **Step 5: Export `invalidateOrgCameraCache` from camera service**

In `src/services/camera.service.ts`, change `invalidateOrgCameraCache` from a private function to an exported function:

Change:
```typescript
async function invalidateOrgCameraCache(redis: Redis, orgId: string): Promise<void> {
```
To:
```typescript
export async function invalidateOrgCameraCache(redis: Redis, orgId: string): Promise<void> {
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- tests/assignments/camera-viewers.test.ts`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/routes/cameras/viewers.ts src/routes/cameras/index.ts src/services/camera.service.ts tests/assignments/camera-viewers.test.ts
git commit -m "feat: add camera-centric viewer assignment routes"
```

---

### Task 4: User-Centric Assignment Routes

**Files:**
- Create: `src/routes/org/users/cameras.ts`
- Modify: `src/routes/org/users/index.ts` (register sub-route)
- Create: `tests/assignments/user-cameras.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assignments/user-cameras.test.ts`:

```typescript
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('User Camera Assignments', () => {
  let app: FastifyInstance;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let viewerId: string;
  let cameraId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'user-cameras');

    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create viewer
    const viewerEmail = `viewer-uc-${Date.now()}@example.com`;
    const viewerPassword = 'password123!';
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerId = viewerRes.json<{ id: string }>().id;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerAccessToken = loginRes.json<{ accessToken: string }>().accessToken;

    // Create camera
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'User Route Camera' },
    });
    cameraId = camRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('POST /api/v1/org/users/:userId/cameras', () => {
    it('adds cameras to a viewer (org admin)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/org/users/${viewerId}/cameras`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { camera_ids: [cameraId] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ assigned: number }>().assigned).toBe(1);
    });

    it('returns 403 for viewer', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/org/users/${viewerId}/cameras`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: { camera_ids: [cameraId] },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 400 for invalid camera IDs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/org/users/${viewerId}/cameras`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { camera_ids: ['00000000-0000-0000-0000-000000000000'] },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/org/users/:userId/cameras', () => {
    it('lists cameras assigned to a viewer', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/org/users/${viewerId}/cameras`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ cameras: Array<{ id: string; name: string; slug: string; status: string; assigned_at: string }> }>();
      expect(body.cameras).toHaveLength(1);
      expect(body.cameras[0]!.id).toBe(cameraId);
    });
  });

  describe('PUT /api/v1/org/users/:userId/cameras', () => {
    it('replaces all cameras for a viewer', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/org/users/${viewerId}/cameras`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { camera_ids: [cameraId] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ assigned: number }>().assigned).toBe(1);
    });
  });

  describe('DELETE /api/v1/org/users/:userId/cameras', () => {
    it('removes cameras from a viewer', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/org/users/${viewerId}/cameras`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { camera_ids: [cameraId] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ removed: number }>().removed).toBe(1);
    });

    it('confirms camera list is empty after removal', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/org/users/${viewerId}/cameras`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ cameras: unknown[] }>().cameras).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/assignments/user-cameras.test.ts`
Expected: FAIL — 404 on `/api/v1/org/users/:userId/cameras`

- [ ] **Step 3: Create the user cameras route file**

Create `src/routes/org/users/cameras.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrgAdmin } from '@middleware/require-org-admin';
import {
  addCamerasToViewer,
  removeCamerasFromViewer,
  replaceCamerasForViewer,
  listCamerasForViewer,
} from '@services/assignment.service';
import { invalidateOrgCameraCache } from '@services/camera.service';

const userIdParamsSchema = z.object({
  userId: z.string().uuid(),
});

const cameraIdsBodySchema = z.object({
  camera_ids: z.array(z.string().uuid()).min(1).max(100),
});

export default async function userCameraRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/org/users/:userId/cameras
  app.post(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      const body = cameraIdsBodySchema.parse(request.body);
      const orgId = request.user.org_id!;

      const assigned = await addCamerasToViewer(app.db, orgId, params.userId, body.camera_ids, request.user.sub);
      await invalidateOrgCameraCache(app.redis, orgId);

      return reply.code(200).send({ assigned });
    },
  );

  // GET /api/v1/org/users/:userId/cameras
  app.get(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      const orgId = request.user.org_id!;

      const cameras = await listCamerasForViewer(app.db, orgId, params.userId);
      return reply.code(200).send({ cameras });
    },
  );

  // PUT /api/v1/org/users/:userId/cameras
  app.put(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      const body = cameraIdsBodySchema.parse(request.body);
      const orgId = request.user.org_id!;

      const assigned = await replaceCamerasForViewer(app.db, orgId, params.userId, body.camera_ids, request.user.sub);
      await invalidateOrgCameraCache(app.redis, orgId);

      return reply.code(200).send({ assigned });
    },
  );

  // DELETE /api/v1/org/users/:userId/cameras
  app.delete(
    '/',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = userIdParamsSchema.parse(request.params);
      const body = cameraIdsBodySchema.parse(request.body);
      const orgId = request.user.org_id!;

      const removed = await removeCamerasFromViewer(app.db, orgId, params.userId, body.camera_ids);
      await invalidateOrgCameraCache(app.redis, orgId);

      return reply.code(200).send({ removed });
    },
  );
}
```

- [ ] **Step 4: Register the sub-route in org user routes**

In `src/routes/org/users/index.ts`, add at the top:

```typescript
import userCameraRoutes from './cameras';
```

At the end of the `orgUserRoutes` function (before the closing `}`), add:

```typescript
  // User camera assignment routes: /api/v1/org/users/:userId/cameras/*
  await app.register(userCameraRoutes, { prefix: '/:userId/cameras' });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/assignments/user-cameras.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/org/users/cameras.ts src/routes/org/users/index.ts tests/assignments/user-cameras.test.ts
git commit -m "feat: add user-centric camera assignment routes"
```

---

### Task 5: Viewer Access Filtering on Existing Endpoints

**Files:**
- Modify: `src/services/camera.service.ts` (add viewer-filtered `listCameras`)
- Modify: `src/routes/cameras/index.ts` (add assignment check on GET /:cameraId and GET /:cameraId/credentials)
- Create: `tests/assignments/viewer-access.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assignments/viewer-access.test.ts`:

```typescript
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Viewer Access Filtering', () => {
  let app: FastifyInstance;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let viewerId: string;
  let assignedCameraId: string;
  let unassignedCameraId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'viewer-access');

    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create viewer
    const viewerEmail = `viewer-va-${Date.now()}@example.com`;
    const viewerPassword = 'password123!';
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerId = viewerRes.json<{ id: string }>().id;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerAccessToken = loginRes.json<{ accessToken: string }>().accessToken;

    // Create two cameras
    const cam1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Assigned Camera' },
    });
    assignedCameraId = cam1Res.json<{ id: string }>().id;

    const cam2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Unassigned Camera' },
    });
    unassignedCameraId = cam2Res.json<{ id: string }>().id;

    // Assign only the first camera to the viewer
    await app.inject({
      method: 'POST',
      url: `/api/v1/cameras/${assignedCameraId}/viewers`,
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { user_ids: [viewerId] },
    });
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('GET /api/v1/cameras (list)', () => {
    it('viewer sees only assigned cameras', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ id: string }>; pagination: { total: number } }>();
      expect(body.pagination.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.id).toBe(assignedCameraId);
    });

    it('org admin sees all cameras', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ id: string }>; pagination: { total: number } }>();
      expect(body.pagination.total).toBeGreaterThanOrEqual(2);
    });
  });

  describe('GET /api/v1/cameras/:cameraId (detail)', () => {
    it('viewer can access assigned camera', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${assignedCameraId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it('viewer gets 403 on unassigned camera', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${unassignedCameraId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('org admin can access any camera', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${unassignedCameraId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/cameras/:cameraId/credentials', () => {
    it('viewer gets 403 on unassigned camera credentials', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${unassignedCameraId}/credentials`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/assignments/viewer-access.test.ts`
Expected: FAIL — viewer currently sees all cameras (no assignment filtering).

- [ ] **Step 3: Add `listCamerasForViewer` query to camera service**

In `src/services/camera.service.ts`, add a new exported function after `listCameras`:

```typescript
export async function listCamerasForViewerUser(
  db: Sql,
  redis: Redis,
  orgId: string,
  userId: string,
  page: number,
  limit: number,
): Promise<PaginatedResult<CameraResponse>> {
  const key = `cameras:list:${orgId}:${userId}:${page}:${limit}`;

  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached) as PaginatedResult<CameraResponse>;
  }

  const offset = (page - 1) * limit;

  const countRows = await db<[{ count: string }]>`
    SELECT COUNT(*) FROM cameras c
    INNER JOIN camera_assignments ca ON ca.camera_id = c.id
    WHERE c.org_id = ${orgId} AND c.is_active = true AND ca.user_id = ${userId}
  `;
  const total = countRows[0] ? parseInt(countRows[0].count, 10) : 0;

  const data = await db<Camera[]>`
    SELECT c.* FROM cameras c
    INNER JOIN camera_assignments ca ON ca.camera_id = c.id
    WHERE c.org_id = ${orgId} AND c.is_active = true AND ca.user_id = ${userId}
    ORDER BY c.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const result: PaginatedResult<CameraResponse> = {
    data: data.map(toCameraResponse),
    pagination: { page, limit, total },
  };

  await redis.setex(key, CACHE_TTL, JSON.stringify(result));

  return result;
}
```

- [ ] **Step 4: Modify the list cameras route handler**

In `src/routes/cameras/index.ts`, add the import for the new function and `isViewerAssigned`:

```typescript
import {
  createCamera,
  listCameras,
  listCamerasForViewerUser,
  getCameraById,
  updateCamera,
  deactivateCamera,
} from '@services/camera.service';
import { isViewerAssigned } from '@services/assignment.service';
```

Replace the GET `/` handler body (the one with `preHandler: [requireUser]`) to branch by role:

```typescript
    async (request, reply) => {
      const query = paginationQuerySchema.parse(request.query);
      const orgId = request.user.org_id!;

      if (request.user.role === 'viewer') {
        const result = await listCamerasForViewerUser(
          app.db,
          app.redis,
          orgId,
          request.user.sub,
          query.page,
          query.limit,
        );
        return reply.code(200).send(result);
      }

      const result = await listCameras(app.db, app.redis, orgId, query.page, query.limit);
      return reply.code(200).send(result);
    },
```

- [ ] **Step 5: Add assignment check to GET /:cameraId**

In the GET `/:cameraId` handler, after the `const camera = await getCameraById(...)` line, add:

```typescript
      // Viewers can only access assigned cameras
      if (request.user.role === 'viewer') {
        const assigned = await isViewerAssigned(app.db, params.cameraId, request.user.sub);
        if (!assigned) {
          throw AppError.forbidden('Camera not assigned to you');
        }
      }
```

- [ ] **Step 6: Change credentials endpoint from requireOrgAdmin to requireUser and add assignment check**

In the GET `/:cameraId/credentials` route definition, change:

```typescript
      preHandler: [requireOrgAdmin],
```
To:
```typescript
      preHandler: [requireUser],
```

Then in the handler, after `if (camera.org_id !== orgId) throw AppError.forbidden('Access denied');`, add:

```typescript
      // Viewers can only access credentials for assigned cameras
      if (request.user.role === 'viewer') {
        const assigned = await isViewerAssigned(app.db, params.cameraId, request.user.sub);
        if (!assigned) {
          throw AppError.forbidden('Camera not assigned to you');
        }
      }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- tests/assignments/viewer-access.test.ts`
Expected: All tests PASS.

- [ ] **Step 8: Run full camera test suite to verify no regressions**

Run: `npm test -- tests/cameras/`
Expected: All existing tests still PASS.

- [ ] **Step 9: Commit**

```bash
git add src/services/camera.service.ts src/routes/cameras/index.ts tests/assignments/viewer-access.test.ts
git commit -m "feat: filter camera access by viewer assignments"
```

---

### Task 6: Inline Assignment on Camera Creation

**Files:**
- Modify: `src/routes/cameras/index.ts` (add `viewer_ids` to POST schema and handler)
- Create: `tests/assignments/inline-assignment.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assignments/inline-assignment.test.ts`:

```typescript
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Inline Camera Assignment', () => {
  let app: FastifyInstance;
  let orgAdminAccessToken: string;
  let viewerId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'inline-assign');

    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create viewer
    const viewerEmail = `viewer-inline-${Date.now()}@example.com`;
    const viewerPassword = 'password123!';
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerId = viewerRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('creates a camera with inline viewer assignment', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: {
        name: 'Inline Assigned Camera',
        viewer_ids: [viewerId],
      },
    });

    expect(res.statusCode).toBe(201);
    const cameraId = res.json<{ id: string }>().id;

    // Verify assignment was created
    const viewersRes = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${cameraId}/viewers`,
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
    });

    expect(viewersRes.statusCode).toBe(200);
    const viewers = viewersRes.json<{ viewers: Array<{ id: string }> }>().viewers;
    expect(viewers).toHaveLength(1);
    expect(viewers[0]!.id).toBe(viewerId);
  });

  it('creates a camera without viewer_ids (no assignments)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'No Inline Camera' },
    });

    expect(res.statusCode).toBe(201);
    const cameraId = res.json<{ id: string }>().id;

    const viewersRes = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${cameraId}/viewers`,
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
    });

    expect(viewersRes.statusCode).toBe(200);
    expect(viewersRes.json<{ viewers: unknown[] }>().viewers).toHaveLength(0);
  });

  it('returns 400 for invalid viewer_ids', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: {
        name: 'Bad Viewer Camera',
        viewer_ids: ['00000000-0000-0000-0000-000000000000'],
      },
    });

    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/assignments/inline-assignment.test.ts`
Expected: FAIL — `viewer_ids` field not recognized / assignments not created.

- [ ] **Step 3: Add `viewer_ids` to the create camera schema and handler**

In `src/routes/cameras/index.ts`, update the `createCameraBodySchema`:

```typescript
const createCameraBodySchema = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
    .min(1)
    .max(100)
    .optional(),
  location: z.string().max(255).optional(),
  timezone: z.string().max(50).optional(),
  rtsp_url: z.string().url().optional(),
  viewer_ids: z.array(z.string().uuid()).min(1).max(100).optional(),
});
```

Update the JSON schema in the POST route `schema.body.properties` to add:

```typescript
            viewer_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
```

In the POST handler, add the import for `addViewersToCamera` at the top of the file (if not already imported):

```typescript
import { addViewersToCamera } from '@services/assignment.service';
```

After the `const camera = await createCamera(...)` call and before the `return reply.code(201).send(camera)`, add:

```typescript
      // Inline viewer assignment
      if (body.viewer_ids && body.viewer_ids.length > 0) {
        await addViewersToCamera(app.db, request.user.org_id!, camera.id, body.viewer_ids, request.user.sub);
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/assignments/inline-assignment.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm test -- tests/cameras/ tests/assignments/`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/cameras/index.ts tests/assignments/inline-assignment.test.ts
git commit -m "feat: support inline viewer_ids on camera creation"
```

---

### Task 7: Cross-Org Assignment Isolation Test

**Files:**
- Create: `tests/assignments/cross-org-isolation.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/assignments/cross-org-isolation.test.ts`:

```typescript
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Cross-Org Assignment Isolation', () => {
  let app: FastifyInstance;
  let orgAAdminToken: string;
  let orgBAdminToken: string;
  let orgAViewerId: string;
  let orgACameraId: string;
  let orgBCameraId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);

    const orgA = await createOrgAndLogin(app, superAdminToken, 'iso-a');
    orgAAdminToken = orgA.orgAdminAccessToken;

    const orgB = await createOrgAndLogin(app, superAdminToken, 'iso-b');
    orgBAdminToken = orgB.orgAdminAccessToken;

    // Create viewer in Org A
    const viewerEmail = `viewer-iso-${Date.now()}@example.com`;
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAAdminToken}` },
      payload: { email: viewerEmail, password: 'password123!' },
    });
    orgAViewerId = viewerRes.json<{ id: string }>().id;

    // Create camera in Org A
    const camARes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAAdminToken}` },
      payload: { name: 'Org A Camera' },
    });
    orgACameraId = camARes.json<{ id: string }>().id;

    // Create camera in Org B
    const camBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgBAdminToken}` },
      payload: { name: 'Org B Camera' },
    });
    orgBCameraId = camBRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('cannot assign Org B camera to Org A viewer via camera-centric endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cameras/${orgBCameraId}/viewers`,
      headers: { authorization: `Bearer ${orgAAdminToken}` },
      payload: { user_ids: [orgAViewerId] },
    });

    // Should fail — camera belongs to Org B, not Org A
    expect(res.statusCode).toBe(404);
  });

  it('cannot assign Org B camera to Org A viewer via user-centric endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/org/users/${orgAViewerId}/cameras`,
      headers: { authorization: `Bearer ${orgAAdminToken}` },
      payload: { camera_ids: [orgBCameraId] },
    });

    // Should fail — camera belongs to Org B
    expect(res.statusCode).toBe(400);
  });

  it('Org B admin cannot assign Org A viewer to Org B camera', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cameras/${orgBCameraId}/viewers`,
      headers: { authorization: `Bearer ${orgBAdminToken}` },
      payload: { user_ids: [orgAViewerId] },
    });

    // Should fail — viewer belongs to Org A, not Org B
    expect(res.statusCode).toBe(400);
  });

  it('Org B admin cannot list viewers for Org A camera', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cameras/${orgACameraId}/viewers`,
      headers: { authorization: `Bearer ${orgBAdminToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- tests/assignments/cross-org-isolation.test.ts`
Expected: All tests PASS (cross-org isolation is enforced by the service layer validations).

- [ ] **Step 3: Commit**

```bash
git add tests/assignments/cross-org-isolation.test.ts
git commit -m "test: add cross-org assignment isolation tests"
```

---

### Task 8: Update Postman Collection and OpenAPI Spec

**Files:**
- Modify: `postman/CCTV-Cloud-Storage.postman_collection.json`
- Modify: `postman/openapi.yml`

- [ ] **Step 1: Add assignment endpoints to OpenAPI spec**

In `postman/openapi.yml`, add the following paths and schemas for camera viewer assignments and user camera assignments. Add these path entries:

**Camera-centric paths:**

```yaml
  /cameras/{cameraId}/viewers:
    post:
      summary: Add viewers to camera
      tags: [Camera Assignments]
      security:
        - bearerAuth: []
      parameters:
        - $ref: '#/components/parameters/cameraId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [user_ids]
              properties:
                user_ids:
                  type: array
                  items:
                    type: string
                    format: uuid
                  minItems: 1
                  maxItems: 100
      responses:
        '200':
          description: Viewers added
          content:
            application/json:
              schema:
                type: object
                properties:
                  assigned:
                    type: integer
        '400':
          $ref: '#/components/responses/BadRequest'
        '404':
          $ref: '#/components/responses/NotFound'
    get:
      summary: List viewers assigned to camera
      tags: [Camera Assignments]
      security:
        - bearerAuth: []
      parameters:
        - $ref: '#/components/parameters/cameraId'
      responses:
        '200':
          description: Viewer list
          content:
            application/json:
              schema:
                type: object
                properties:
                  viewers:
                    type: array
                    items:
                      type: object
                      properties:
                        id:
                          type: string
                          format: uuid
                        email:
                          type: string
                        assigned_at:
                          type: string
                          format: date-time
    put:
      summary: Replace all viewers for camera
      tags: [Camera Assignments]
      security:
        - bearerAuth: []
      parameters:
        - $ref: '#/components/parameters/cameraId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [user_ids]
              properties:
                user_ids:
                  type: array
                  items:
                    type: string
                    format: uuid
      responses:
        '200':
          description: Viewers replaced
          content:
            application/json:
              schema:
                type: object
                properties:
                  assigned:
                    type: integer
    delete:
      summary: Remove viewers from camera
      tags: [Camera Assignments]
      security:
        - bearerAuth: []
      parameters:
        - $ref: '#/components/parameters/cameraId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [user_ids]
              properties:
                user_ids:
                  type: array
                  items:
                    type: string
                    format: uuid
      responses:
        '200':
          description: Viewers removed
          content:
            application/json:
              schema:
                type: object
                properties:
                  removed:
                    type: integer
```

**User-centric paths:**

```yaml
  /org/users/{userId}/cameras:
    post:
      summary: Add cameras to viewer
      tags: [User Camera Assignments]
      security:
        - bearerAuth: []
      parameters:
        - $ref: '#/components/parameters/userId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [camera_ids]
              properties:
                camera_ids:
                  type: array
                  items:
                    type: string
                    format: uuid
                  minItems: 1
                  maxItems: 100
      responses:
        '200':
          description: Cameras added
          content:
            application/json:
              schema:
                type: object
                properties:
                  assigned:
                    type: integer
    get:
      summary: List cameras assigned to viewer
      tags: [User Camera Assignments]
      security:
        - bearerAuth: []
      parameters:
        - $ref: '#/components/parameters/userId'
      responses:
        '200':
          description: Camera list
          content:
            application/json:
              schema:
                type: object
                properties:
                  cameras:
                    type: array
                    items:
                      type: object
                      properties:
                        id:
                          type: string
                          format: uuid
                        name:
                          type: string
                        slug:
                          type: string
                        status:
                          type: string
                        assigned_at:
                          type: string
                          format: date-time
    put:
      summary: Replace all cameras for viewer
      tags: [User Camera Assignments]
      security:
        - bearerAuth: []
      parameters:
        - $ref: '#/components/parameters/userId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [camera_ids]
              properties:
                camera_ids:
                  type: array
                  items:
                    type: string
                    format: uuid
      responses:
        '200':
          description: Cameras replaced
          content:
            application/json:
              schema:
                type: object
                properties:
                  assigned:
                    type: integer
    delete:
      summary: Remove cameras from viewer
      tags: [User Camera Assignments]
      security:
        - bearerAuth: []
      parameters:
        - $ref: '#/components/parameters/userId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [camera_ids]
              properties:
                camera_ids:
                  type: array
                  items:
                    type: string
                    format: uuid
      responses:
        '200':
          description: Cameras removed
          content:
            application/json:
              schema:
                type: object
                properties:
                  removed:
                    type: integer
```

Also add `viewer_ids` as an optional field to the POST `/cameras` request body:

```yaml
                viewer_ids:
                  type: array
                  items:
                    type: string
                    format: uuid
                  description: Optional list of viewer user IDs to assign to this camera
```

And add a `userId` parameter to components if not already present:

```yaml
    userId:
      name: userId
      in: path
      required: true
      schema:
        type: string
        format: uuid
```

- [ ] **Step 2: Add assignment requests to Postman collection**

Add a new folder "Camera Assignments" to the Postman collection with requests for all 8 endpoints. Each request should use `{{baseUrl}}`, `{{orgAccessToken}}`, `{{cameraId}}`, and a new `{{viewerUserId}}` variable.

- [ ] **Step 3: Commit**

```bash
git add postman/openapi.yml postman/CCTV-Cloud-Storage.postman_collection.json
git commit -m "docs: add camera assignment endpoints to OpenAPI and Postman"
```

---

## File Structure Summary

| Action | Path | Purpose |
|--------|------|---------|
| Create | `src/db/migrations/005_camera_assignments.ts` | Migration for join table |
| Create | `src/services/assignment.service.ts` | All assignment CRUD logic |
| Create | `src/routes/cameras/viewers.ts` | Camera-centric assignment routes |
| Create | `src/routes/org/users/cameras.ts` | User-centric assignment routes |
| Modify | `src/services/camera.service.ts` | Export `invalidateOrgCameraCache`, add `listCamerasForViewerUser` |
| Modify | `src/routes/cameras/index.ts` | Register viewer routes, add assignment checks, inline `viewer_ids` |
| Modify | `src/routes/org/users/index.ts` | Register user camera routes |
| Create | `tests/assignments/assignment-service.test.ts` | Service unit tests |
| Create | `tests/assignments/camera-viewers.test.ts` | Camera-centric route tests |
| Create | `tests/assignments/user-cameras.test.ts` | User-centric route tests |
| Create | `tests/assignments/viewer-access.test.ts` | Viewer filtering tests |
| Create | `tests/assignments/inline-assignment.test.ts` | Inline assignment tests |
| Create | `tests/assignments/cross-org-isolation.test.ts` | Cross-org isolation tests |
| Modify | `postman/openapi.yml` | Add assignment endpoint docs |
| Modify | `postman/CCTV-Cloud-Storage.postman_collection.json` | Add assignment requests |
