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
import { AppError, ErrorCodes } from '@utils/errors';
import { env } from '@config/env';
import { createIoTThing, deleteIoTThing } from '@services/iot.service';
import { getOrgAccess } from '@services/entitlement.service';

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

/**
 * Locks the org row for the rest of the transaction so two concurrent camera
 * creations cannot both pass the limit check. Returns the org slug.
 */
async function lockOrganizationForCameraChange(db: Sql, orgId: string): Promise<string> {
  const rows = await db<[{ slug: string }]>`
    SELECT slug FROM organizations WHERE id = ${orgId} FOR UPDATE
  `;
  const org = rows[0];
  if (!org) throw new Error('Organization not found');
  return org.slug;
}

/**
 * Refuses a new active camera when the org is already at its AWS Marketplace
 * limit. After a downgrade, cameras already over the limit keep running; only
 * new ones are refused. A null limit means unlimited.
 */
async function assertCameraLimitAllowsAnother(
  db: Sql,
  orgId: string,
  cameraLimit: number | null,
): Promise<void> {
  if (cameraLimit === null) return;

  const rows = await db<[{ count: string }]>`
    SELECT COUNT(*) FROM cameras WHERE org_id = ${orgId} AND is_active = true
  `;
  const activeCameras = parseInt(rows[0]?.count ?? '0', 10);
  if (activeCameras >= cameraLimit) {
    throw new AppError(
      ErrorCodes.CAMERA_LIMIT_REACHED,
      `Your subscription allows ${cameraLimit} active cameras. Remove a camera or upgrade your subscription in AWS Marketplace.`,
      403,
    );
  }
}

/** Auto-generated slugs are cam1, cam2, ... from the org's camera_seq counter. */
async function nextAutoCameraSlug(db: Sql, orgId: string): Promise<string> {
  const rows = await db<[{ camera_seq: number }]>`
    UPDATE organizations
    SET camera_seq = camera_seq + 1
    WHERE id = ${orgId}
    RETURNING camera_seq
  `;
  const seq = rows[0];
  if (!seq) throw new Error('Failed to increment camera_seq');
  return `cam${seq.camera_seq}`;
}

async function insertCameraRow(
  db: Sql,
  orgId: string,
  cameraSlug: string,
  streamName: string,
  data: { name: string; location?: string; timezone?: string },
): Promise<Camera[]> {
  return db<Camera[]>`
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
  // The limit comes from AWS Marketplace; direct orgs have none (null).
  const { cameraLimit } = await getOrgAccess(db, redis, orgId);

  let rows: Camera[];
  try {
    rows = (await db.begin(async (tx: TransactionSql) => {
      const txSql = tx as unknown as Sql;
      const orgSlug = await lockOrganizationForCameraChange(txSql, orgId);
      await assertCameraLimitAllowsAnother(txSql, orgId, cameraLimit);
      const cameraSlug = data.slug ?? (await nextAutoCameraSlug(txSql, orgId));
      return insertCameraRow(txSql, orgId, cameraSlug, `${orgSlug}-${cameraSlug}`, data);
    })) as Camera[];
  } catch (err) {
    if (isPostgresError(err) && err.code === '23505') {
      throw AppError.conflict('Camera slug already taken in this organization');
    }
    throw err;
  }

  const camera = rows[0];
  if (!camera) throw new Error('Insert returned no rows');
  const streamName = camera.kvs_stream_name;

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
