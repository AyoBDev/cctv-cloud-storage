import type { Sql, TransactionSql } from 'postgres';
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

async function validateCameraIds(db: Sql, orgId: string, cameraIds: string[]): Promise<void> {
  const rows = await db<Array<{ id: string }>>`
    SELECT id FROM cameras
    WHERE id = ANY(${cameraIds}) AND org_id = ${orgId} AND is_active = true
  `;

  if (rows.length !== cameraIds.length) {
    throw AppError.badRequest('One or more camera IDs are invalid or do not belong to this organization');
  }
}

async function verifyCameraOrg(db: Sql, orgId: string, cameraId: string): Promise<void> {
  const rows = await db<Array<{ id: string }>>`
    SELECT id FROM cameras WHERE id = ${cameraId} AND org_id = ${orgId} AND is_active = true
  `;
  if (rows.length === 0) {
    throw AppError.notFound('Camera not found');
  }
}

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

  return await db.begin(async (tx: TransactionSql) => {
    await (tx as unknown as Sql)`DELETE FROM camera_assignments WHERE camera_id = ${cameraId}`;

    if (userIds.length === 0) return 0;

    const values = userIds.map((uid) => ({ camera_id: cameraId, user_id: uid, assigned_by: assignedBy }));

    const rows = await (tx as unknown as Sql)`
      INSERT INTO camera_assignments ${(tx as unknown as Sql)(values, 'camera_id', 'user_id', 'assigned_by')}
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

  return await db.begin(async (tx: TransactionSql) => {
    await (tx as unknown as Sql)`DELETE FROM camera_assignments WHERE user_id = ${userId}`;

    if (cameraIds.length === 0) return 0;

    const values = cameraIds.map((cid) => ({ camera_id: cid, user_id: userId, assigned_by: assignedBy }));

    const rows = await (tx as unknown as Sql)`
      INSERT INTO camera_assignments ${(tx as unknown as Sql)(values, 'camera_id', 'user_id', 'assigned_by')}
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
