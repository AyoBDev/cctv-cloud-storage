import type { Sql, TransactionSql } from 'postgres';
import type { Redis } from 'ioredis';
import type { KinesisVideoClient } from '@aws-sdk/client-kinesis-video';
import type { KMSClient } from '@aws-sdk/client-kms';
import type { IoTClient } from '@aws-sdk/client-iot';
import {
  CreateStreamCommand,
  DeleteStreamCommand,
  GetDataEndpointCommand,
} from '@aws-sdk/client-kinesis-video';
import {
  KinesisVideoArchivedMediaClient,
  GetHLSStreamingSessionURLCommand,
} from '@aws-sdk/client-kinesis-video-archived-media';
import { encryptRtspUrl, decryptRtspUrl } from '@utils/kms';
import { AppError } from '@utils/errors';
import { env } from '@config/env';
import { createIoTThing, deleteIoTThing } from '@services/iot.service';

interface PostgresError {
  code?: string;
  constraint?: string;
}

function isPostgresError(err: unknown): err is PostgresError {
  return typeof err === 'object' && err !== null && 'code' in err;
}

export interface Camera {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  location: string | null;
  timezone: string;
  rtsp_url_encrypted: string | null;
  kvs_stream_name: string;
  kvs_stream_arn: string | null;
  status: 'provisioning' | 'online' | 'offline' | 'inactive';
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  iot_thing_name: string | null;
  iot_certificate_id: string | null;
  iot_certificate_arn: string | null;
  credentials_issued: boolean;
  credentials_issued_at: Date | null;
}

export interface CameraResponse {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  location: string | null;
  timezone: string;
  kvs_stream_name: string;
  kvs_stream_arn: string | null;
  status: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number };
}

const CACHE_TTL = 120; // 2 minutes
const isTestEnv = () => env.NODE_ENV === 'test';

function cacheKeyPrefix(orgId: string): string {
  return `cameras:list:${orgId}:`;
}

function cacheKey(orgId: string, page: number, limit: number): string {
  return `cameras:list:${orgId}:${page}:${limit}`;
}

export async function invalidateOrgCameraCache(redis: Redis, orgId: string): Promise<void> {
  const pattern = `${cacheKeyPrefix(orgId)}*`;
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

function toCameraResponse(camera: Camera): CameraResponse {
  return {
    id: camera.id,
    org_id: camera.org_id,
    name: camera.name,
    slug: camera.slug,
    location: camera.location,
    timezone: camera.timezone,
    kvs_stream_name: camera.kvs_stream_name,
    kvs_stream_arn: camera.kvs_stream_arn,
    status: camera.status,
    is_active: camera.is_active,
    created_at: camera.created_at,
    updated_at: camera.updated_at,
  };
}

export async function createCamera(
  db: Sql,
  redis: Redis,
  kvs: KinesisVideoClient,
  kms: KMSClient,
  iot: IoTClient,
  orgId: string,
  data: { name: string; slug?: string; location?: string; timezone?: string; rtsp_url?: string },
): Promise<CameraResponse> {
  // Look up the org slug
  const orgRows = await db<[{ slug: string; camera_seq: number }]>`
    SELECT slug, camera_seq FROM organizations WHERE id = ${orgId}
  `;
  const org = orgRows[0];
  if (!org) throw new Error('Organization not found');

  let cameraSlug: string;

  if (data.slug) {
    // User-provided slug
    cameraSlug = data.slug;
  } else {
    // Auto-generate: increment camera_seq and use cam{n}
    const seqRows = await db<[{ camera_seq: number }]>`
      UPDATE organizations
      SET camera_seq = camera_seq + 1
      WHERE id = ${orgId}
      RETURNING camera_seq
    `;
    const seq = seqRows[0];
    if (!seq) throw new Error('Failed to increment camera_seq');
    cameraSlug = `cam${seq.camera_seq}`;
  }

  const streamName = `${org.slug}-${cameraSlug}`;

  // Insert camera with slug and stream name
  let rows: Camera[];
  try {
    rows = await db<Camera[]>`
      INSERT INTO cameras (org_id, name, slug, location, timezone, kvs_stream_name)
      VALUES (
        ${orgId},
        ${data.name},
        ${cameraSlug},
        ${data.location ?? null},
        ${data.timezone ?? 'UTC'},
        ${streamName}
      )
      RETURNING *
    `;
  } catch (err) {
    if (isPostgresError(err) && err.code === '23505') {
      throw AppError.conflict('Camera slug already taken in this organization');
    }
    throw err;
  }

  const camera = rows[0];
  if (!camera) throw new Error('Insert returned no rows');

  let streamArn: string | null = null;
  let iotThingName: string | null = null;

  // Provision KVS stream (skip in test)
  if (!isTestEnv()) {
    try {
      const result = await kvs.send(
        new CreateStreamCommand({
          StreamName: streamName,
          DataRetentionInHours: 48,
        }),
      );
      streamArn = result.StreamARN ?? null;
    } catch (err) {
      await db`DELETE FROM cameras WHERE id = ${camera.id}`;
      throw err;
    }
  }

  // Create IoT Thing (skip in test)
  if (!isTestEnv()) {
    try {
      await createIoTThing(iot, streamName, env.IOT_THING_TYPE);
      iotThingName = streamName;
    } catch (err) {
      if (streamArn) {
        await kvs.send(new DeleteStreamCommand({ StreamARN: streamArn }));
      }
      await db`DELETE FROM cameras WHERE id = ${camera.id}`;
      throw err;
    }
  } else {
    iotThingName = streamName;
  }

  // Encrypt RTSP URL if provided
  let encryptedUrl: string | null = null;
  if (data.rtsp_url) {
    encryptedUrl = await encryptRtspUrl(kms, env.KMS_KEY_ID, data.rtsp_url);
  }

  // Update with ARN, IoT Thing name, and encrypted URL
  const updated = await db<Camera[]>`
    UPDATE cameras
    SET kvs_stream_arn = ${streamArn},
        iot_thing_name = ${iotThingName},
        rtsp_url_encrypted = ${encryptedUrl},
        status = 'provisioning'
    WHERE id = ${camera.id}
    RETURNING *
  `;

  const result = updated[0];
  if (!result) throw new Error('Update returned no rows');

  await invalidateOrgCameraCache(redis, orgId);

  return toCameraResponse(result);
}

export async function listCameras(
  db: Sql,
  redis: Redis,
  orgId: string,
  page: number,
  limit: number,
): Promise<PaginatedResult<CameraResponse>> {
  const key = cacheKey(orgId, page, limit);

  // Try cache first
  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached) as PaginatedResult<CameraResponse>;
  }

  const offset = (page - 1) * limit;

  const countRows = await db<[{ count: string }]>`
    SELECT COUNT(*) FROM cameras WHERE org_id = ${orgId} AND is_active = true
  `;
  const total = countRows[0] ? parseInt(countRows[0].count, 10) : 0;

  const data = await db<Camera[]>`
    SELECT * FROM cameras
    WHERE org_id = ${orgId} AND is_active = true
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const result: PaginatedResult<CameraResponse> = {
    data: data.map(toCameraResponse),
    pagination: { page, limit, total },
  };

  // Cache result
  await redis.setex(key, CACHE_TTL, JSON.stringify(result));

  return result;
}

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

export async function getCameraById(
  db: Sql,
  kms: KMSClient,
  orgId: string,
  cameraId: string,
): Promise<CameraResponse & { rtsp_url?: string }> {
  const rows = await db<Camera[]>`
    SELECT * FROM cameras WHERE id = ${cameraId} AND is_active = true
  `;

  const camera = rows[0];
  if (!camera) throw AppError.notFound('Camera not found');

  if (camera.org_id !== orgId) {
    throw AppError.forbidden('Access denied');
  }

  const response: CameraResponse & { rtsp_url?: string } = toCameraResponse(camera);

  // Decrypt RTSP URL if present
  if (camera.rtsp_url_encrypted) {
    response.rtsp_url = await decryptRtspUrl(kms, env.KMS_KEY_ID, camera.rtsp_url_encrypted);
  }

  return response;
}

export async function updateCamera(
  db: Sql,
  redis: Redis,
  kms: KMSClient,
  orgId: string,
  cameraId: string,
  updates: { name?: string; location?: string; timezone?: string; rtsp_url?: string },
): Promise<CameraResponse> {
  // Verify camera belongs to org
  const existing = await db<Camera[]>`
    SELECT * FROM cameras WHERE id = ${cameraId} AND is_active = true
  `;

  const camera = existing[0];
  if (!camera) throw AppError.notFound('Camera not found');

  if (camera.org_id !== orgId) {
    throw AppError.forbidden('Access denied');
  }

  // Build updates
  let newName = camera.name;
  let newLocation = camera.location;
  let newTimezone = camera.timezone;
  let newRtspEncrypted = camera.rtsp_url_encrypted;

  if (updates.name !== undefined) newName = updates.name;
  if (updates.location !== undefined) newLocation = updates.location;
  if (updates.timezone !== undefined) newTimezone = updates.timezone;
  if (updates.rtsp_url !== undefined) {
    newRtspEncrypted = await encryptRtspUrl(kms, env.KMS_KEY_ID, updates.rtsp_url);
  }

  const rows = await db<Camera[]>`
    UPDATE cameras
    SET name = ${newName},
        location = ${newLocation},
        timezone = ${newTimezone},
        rtsp_url_encrypted = ${newRtspEncrypted}
    WHERE id = ${cameraId} AND org_id = ${orgId}
    RETURNING *
  `;

  const updated = rows[0];
  if (!updated) throw AppError.notFound('Camera not found');

  await invalidateOrgCameraCache(redis, orgId);

  return toCameraResponse(updated);
}

export async function deactivateCamera(
  db: Sql,
  redis: Redis,
  kvs: KinesisVideoClient,
  iot: IoTClient,
  orgId: string,
  cameraId: string,
): Promise<void> {
  const existing = await db<Camera[]>`
    SELECT * FROM cameras WHERE id = ${cameraId} AND is_active = true
  `;

  const camera = existing[0];
  if (!camera) throw AppError.notFound('Camera not found');

  if (camera.org_id !== orgId) {
    throw AppError.forbidden('Access denied');
  }

  // Clean up IoT resources (skip in test)
  if (!isTestEnv() && camera.iot_thing_name) {
    await deleteIoTThing(
      iot,
      camera.iot_thing_name,
      env.IOT_POLICY_NAME,
      camera.iot_certificate_id,
      camera.iot_certificate_arn,
    );
  }

  // Delete KVS stream (skip in test)
  if (!isTestEnv() && camera.kvs_stream_arn) {
    await kvs.send(
      new DeleteStreamCommand({
        StreamARN: camera.kvs_stream_arn,
      }),
    );
  }

  await db`
    UPDATE cameras
    SET is_active = false, status = 'inactive'
    WHERE id = ${cameraId} AND org_id = ${orgId}
  `;

  await invalidateOrgCameraCache(redis, orgId);
}

export async function updateCameraStatus(
  db: Sql,
  redis: Redis,
  kvsStreamName: string,
  status: 'online' | 'offline',
): Promise<void> {
  const rows = await db<Camera[]>`
    UPDATE cameras
    SET status = ${status}
    WHERE kvs_stream_name = ${kvsStreamName} AND is_active = true
    RETURNING *
  `;

  const camera = rows[0];
  if (!camera) throw AppError.notFound('Camera not found');

  await invalidateOrgCameraCache(redis, camera.org_id);
}

/**
 * Returns the stream names of all cameras eligible for status reconciliation:
 * active cameras that are not permanently deactivated. Used by the reconciler
 * to decide which KVS streams to probe for recent media.
 */
export async function getReconcilableCameras(
  db: Sql,
): Promise<{ kvs_stream_name: string }[]> {
  return db<{ kvs_stream_name: string }[]>`
    SELECT kvs_stream_name FROM cameras
    WHERE is_active = true AND status <> 'inactive'
  `;
}

export interface ReconcileUpdate {
  kvs_stream_name: string;
  has_media: boolean;
}

export interface ReconcileResult {
  kvs_stream_name: string;
  status: string;
  changed: boolean;
}

/**
 * Reconciles camera statuses against observed KVS media, applying a grace
 * window so a single missed cycle does not flap a camera offline.
 *
 * Policy per update:
 *  - has_media=true  → refresh last_seen_at; promote to 'online' if not already.
 *  - has_media=false → demote 'online' → 'offline' ONLY when last_seen_at is
 *    older than graceSeconds. 'provisioning' and 'offline' are never demoted.
 *  - unknown stream name → skipped silently (absent from the result).
 *
 * All writes happen in one transaction. Org camera caches are invalidated once
 * per affected org after the row loop.
 */
export async function reconcileCameraStatuses(
  db: Sql,
  redis: Redis,
  updates: ReconcileUpdate[],
  graceSeconds: number,
): Promise<ReconcileResult[]> {
  return db.begin(async (txRaw: TransactionSql) => {
    const tx = txRaw as unknown as Sql;
    const results: ReconcileResult[] = [];
    const changedOrgIds = new Set<string>();

    for (const u of updates) {
      const rows = await tx<
        { id: string; org_id: string; status: string }[]
      >`
        SELECT id, org_id, status FROM cameras
        WHERE kvs_stream_name = ${u.kvs_stream_name} AND is_active = true
      `;
      const cam = rows[0];
      if (!cam) continue;

      let newStatus = cam.status;
      let changed = false;

      if (u.has_media) {
        await tx`UPDATE cameras SET last_seen_at = now() WHERE id = ${cam.id}`;
        if (cam.status !== 'online') {
          newStatus = 'online';
          changed = true;
        }
      } else if (cam.status === 'online') {
        const stale = await tx<{ stale: boolean }[]>`
          SELECT (
            last_seen_at IS NOT NULL
            AND now() - last_seen_at > ${graceSeconds} * interval '1 second'
          ) AS stale
          FROM cameras WHERE id = ${cam.id}
        `;
        if (stale[0]?.stale) {
          newStatus = 'offline';
          changed = true;
        }
      }

      if (changed) {
        await tx`
          UPDATE cameras SET status = ${newStatus}::camera_status
          WHERE id = ${cam.id}
        `;
        changedOrgIds.add(cam.org_id);
      }

      results.push({
        kvs_stream_name: u.kvs_stream_name,
        status: newStatus,
        changed,
      });
    }

    for (const orgId of changedOrgIds) {
      await invalidateOrgCameraCache(redis, orgId);
    }

    return results;
  });
}

export async function listAllCameras(
  db: Sql,
  page: number,
  limit: number,
  orgId?: string,
): Promise<PaginatedResult<CameraResponse>> {
  const offset = (page - 1) * limit;

  let total: number;
  let data: Camera[];

  if (orgId) {
    const countRows = await db<[{ count: string }]>`
      SELECT COUNT(*) FROM cameras WHERE org_id = ${orgId}
    `;
    total = countRows[0] ? parseInt(countRows[0].count, 10) : 0;

    data = await db<Camera[]>`
      SELECT * FROM cameras
      WHERE org_id = ${orgId}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    const countRows = await db<[{ count: string }]>`
      SELECT COUNT(*) FROM cameras
    `;
    total = countRows[0] ? parseInt(countRows[0].count, 10) : 0;

    data = await db<Camera[]>`
      SELECT * FROM cameras
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return {
    data: data.map(toCameraResponse),
    pagination: { page, limit, total },
  };
}

const HLS_EXPIRES_SECONDS = 900; // 15 minutes

export interface HlsStreamResponse {
  hls_url: string;
  expires_in: number;
}

export async function getHlsStreamUrl(
  db: Sql,
  kvs: KinesisVideoClient,
  orgId: string,
  cameraId: string,
): Promise<HlsStreamResponse> {
  // Verify camera exists and belongs to org
  const rows = await db<Camera[]>`
    SELECT * FROM cameras
    WHERE id = ${cameraId} AND org_id = ${orgId} AND is_active = true
  `;

  const camera = rows[0];
  if (!camera) throw AppError.notFound('Camera not found');

  if (camera.status !== 'online') {
    throw AppError.badRequest(`Camera is not online (current status: ${camera.status})`);
  }

  // In test env, return a mock URL
  if (isTestEnv()) {
    return {
      hls_url: `https://mock-kvs.amazonaws.com/hls/${camera.kvs_stream_name}/master.m3u8`,
      expires_in: HLS_EXPIRES_SECONDS,
    };
  }

  // Step 1: Get the HLS data endpoint for this stream
  const endpointResponse = await kvs.send(
    new GetDataEndpointCommand({
      StreamName: camera.kvs_stream_name,
      APIName: 'GET_HLS_STREAMING_SESSION_URL',
    }),
  );

  if (!endpointResponse.DataEndpoint) {
    throw AppError.badRequest('Failed to get KVS data endpoint');
  }

  // Step 2: Create an archived media client pointed at the data endpoint
  const archivedMediaClient = new KinesisVideoArchivedMediaClient({
    region: env.AWS_REGION,
    endpoint: endpointResponse.DataEndpoint,
  });

  // Step 3: Get the HLS streaming session URL
  const hlsResponse = await archivedMediaClient.send(
    new GetHLSStreamingSessionURLCommand({
      StreamName: camera.kvs_stream_name,
      PlaybackMode: 'LIVE',
      HLSFragmentSelector: {
        FragmentSelectorType: 'SERVER_TIMESTAMP',
      },
      ContainerFormat: 'FRAGMENTED_MP4',
      DiscontinuityMode: 'ALWAYS',
      DisplayFragmentTimestamp: 'ALWAYS',
      Expires: HLS_EXPIRES_SECONDS,
    }),
  );

  archivedMediaClient.destroy();

  if (!hlsResponse.HLSStreamingSessionURL) {
    throw AppError.badRequest('Failed to generate HLS streaming URL');
  }

  return {
    hls_url: hlsResponse.HLSStreamingSessionURL,
    expires_in: HLS_EXPIRES_SECONDS,
  };
}
