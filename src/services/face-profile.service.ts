import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';
import { createCollection, indexFace, deleteFace } from '@services/rekognition.service';
import { uploadFaceImage, getSignedUrl, deleteObject } from '@services/s3.service';
import { AppError } from '@utils/errors';

export interface FaceProfile {
  id: string;
  org_id: string;
  face_id: string;
  label: string;
  image_key: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface FaceProfileResponse {
  id: string;
  label: string;
  face_id: string;
  image_url: string;
  created_at: Date;
}

export interface PaginatedFaceProfiles {
  data: FaceProfileResponse[];
  pagination: { page: number; limit: number; total: number };
}

const CACHE_TTL = 120;

function cacheKey(orgId: string, page: number, limit: number): string {
  return `face-profiles:list:${orgId}:${page}:${limit}`;
}

async function invalidateCache(redis: Redis, orgId: string): Promise<void> {
  const pattern = `face-profiles:list:${orgId}:*`;
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

async function toResponse(profile: FaceProfile): Promise<FaceProfileResponse> {
  const imageUrl = await getSignedUrl(profile.image_key, 3600);
  return {
    id: profile.id,
    label: profile.label,
    face_id: profile.face_id,
    image_url: imageUrl,
    created_at: profile.created_at,
  };
}

export async function createFaceProfile(
  db: Sql,
  redis: Redis,
  orgId: string,
  userId: string,
  label: string,
  imageBuffer: Buffer,
  mimeType: string,
): Promise<FaceProfileResponse> {
  await createCollection(orgId);
  const faceId = await indexFace(orgId, imageBuffer);

  const rows = await db<FaceProfile[]>`
    INSERT INTO face_profiles (org_id, face_id, label, image_key, created_by)
    VALUES (${orgId}, ${faceId}, ${label}, 'pending', ${userId})
    RETURNING *
  `;

  const profile = rows[0];
  if (!profile) throw new Error('Insert returned no rows');

  const imageKey = await uploadFaceImage(orgId, profile.id, imageBuffer, mimeType);

  const updated = await db<FaceProfile[]>`
    UPDATE face_profiles SET image_key = ${imageKey} WHERE id = ${profile.id} RETURNING *
  `;

  await invalidateCache(redis, orgId);
  return toResponse(updated[0]!);
}

export async function listFaceProfiles(
  db: Sql,
  redis: Redis,
  orgId: string,
  page: number,
  limit: number,
): Promise<PaginatedFaceProfiles> {
  const key = cacheKey(orgId, page, limit);
  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached) as PaginatedFaceProfiles;
  }

  const offset = (page - 1) * limit;

  const countRows = await db<[{ count: string }]>`
    SELECT COUNT(*) FROM face_profiles WHERE org_id = ${orgId}
  `;
  const total = countRows[0] ? parseInt(countRows[0].count, 10) : 0;

  const profiles = await db<FaceProfile[]>`
    SELECT * FROM face_profiles
    WHERE org_id = ${orgId}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const data = await Promise.all(profiles.map(toResponse));
  const result: PaginatedFaceProfiles = { data, pagination: { page, limit, total } };
  await redis.setex(key, CACHE_TTL, JSON.stringify(result));
  return result;
}

export async function getFaceProfileById(
  db: Sql,
  orgId: string,
  profileId: string,
): Promise<FaceProfileResponse> {
  const rows = await db<FaceProfile[]>`
    SELECT * FROM face_profiles WHERE id = ${profileId} AND org_id = ${orgId}
  `;
  const profile = rows[0];
  if (!profile) throw AppError.notFound('Face profile not found');
  return toResponse(profile);
}

export async function deleteFaceProfile(
  db: Sql,
  redis: Redis,
  orgId: string,
  profileId: string,
): Promise<void> {
  const rows = await db<FaceProfile[]>`
    SELECT * FROM face_profiles WHERE id = ${profileId} AND org_id = ${orgId}
  `;
  const profile = rows[0];
  if (!profile) throw AppError.notFound('Face profile not found');

  await deleteFace(orgId, profile.face_id);
  await deleteObject(profile.image_key);
  await db`DELETE FROM face_profiles WHERE id = ${profileId}`;
  await invalidateCache(redis, orgId);
}
