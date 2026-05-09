import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';
import { uploadEventThumbnail, getSignedUrl } from '@services/s3.service';
import { searchUnknownByImage, indexUnknownFace } from '@services/rekognition.service';
import { sendUnknownFaceAlert } from '@services/ses.service';
import { AppError } from '@utils/errors';
import { env } from '@config/env';

export interface RecognitionEvent {
  id: string;
  org_id: string;
  camera_id: string;
  face_profile_id: string | null;
  event_type: 'known_face' | 'unknown_face';
  confidence: number;
  thumbnail_key: string | null;
  unknown_face_id: string | null;
  created_at: Date;
}

export interface RecognitionEventResponse {
  id: string;
  org_id: string;
  camera_id: string;
  face_profile_id: string | null;
  event_type: string;
  confidence: number;
  thumbnail_url: string | null;
  unknown_face_id: string | null;
  created_at: Date;
}

export interface CursorPaginatedResult {
  data: RecognitionEventResponse[];
  pagination: { cursor: string | null; has_more: boolean };
}

export interface CreateEventInput {
  org_id: string;
  camera_id: string;
  image_bytes: string; // base64
  confidence: number;
  face_profile_id: string | null;
  event_type: 'known_face' | 'unknown_face';
}

async function toResponse(event: RecognitionEvent): Promise<RecognitionEventResponse> {
  const thumbnailUrl = event.thumbnail_key ? await getSignedUrl(event.thumbnail_key, 3600) : null;
  return {
    id: event.id,
    org_id: event.org_id,
    camera_id: event.camera_id,
    face_profile_id: event.face_profile_id,
    event_type: event.event_type,
    confidence: Number(event.confidence),
    thumbnail_url: thumbnailUrl,
    unknown_face_id: event.unknown_face_id,
    created_at: event.created_at,
  };
}

export async function createRecognitionEvent(
  db: Sql,
  redis: Redis,
  input: CreateEventInput,
): Promise<RecognitionEventResponse> {
  const imageBuffer = Buffer.from(input.image_bytes, 'base64');
  let unknownFaceId: string | null = null;
  let shouldAlert = false;

  if (input.event_type === 'unknown_face') {
    const existingFaceId = await searchUnknownByImage(input.org_id, imageBuffer);
    if (existingFaceId) {
      unknownFaceId = existingFaceId;
    } else {
      unknownFaceId = await indexUnknownFace(input.org_id, imageBuffer);
      shouldAlert = true;
    }
  }

  const rows = await db<RecognitionEvent[]>`
    INSERT INTO recognition_events (org_id, camera_id, face_profile_id, event_type, confidence, unknown_face_id)
    VALUES (
      ${input.org_id},
      ${input.camera_id},
      ${input.face_profile_id},
      ${input.event_type},
      ${input.confidence},
      ${unknownFaceId}
    )
    RETURNING *
  `;

  const event = rows[0]!;

  const thumbnailKey = await uploadEventThumbnail(input.org_id, event.id, imageBuffer);
  await db`UPDATE recognition_events SET thumbnail_key = ${thumbnailKey} WHERE id = ${event.id}`;
  event.thumbnail_key = thumbnailKey;

  if (shouldAlert && unknownFaceId) {
    const alertKey = `alert:${input.org_id}:${input.camera_id}:${unknownFaceId}`;
    const alreadyAlerted = await redis.get(alertKey);

    if (!alreadyAlerted) {
      await redis.setex(alertKey, env.ALERT_DEBOUNCE_SECONDS, '1');

      const orgRows = await db<[{ email: string }]>`
        SELECT u.email FROM users u
        WHERE u.org_id = ${input.org_id} AND u.role = 'org_admin'
        LIMIT 1
      `;
      const cameraRows = await db<[{ name: string }]>`
        SELECT name FROM cameras WHERE id = ${input.camera_id}
      `;

      if (orgRows[0] && cameraRows[0]) {
        const thumbnailUrl = await getSignedUrl(thumbnailKey, 3600);
        await sendUnknownFaceAlert({
          toEmail: orgRows[0].email,
          cameraName: cameraRows[0].name,
          thumbnailUrl,
          timestamp: new Date().toISOString(),
          orgId: input.org_id,
        });
      }
    }
  }

  return toResponse(event);
}

export interface ListEventsFilters {
  camera_id?: string | undefined;
  face_profile_id?: string | undefined;
  event_type?: 'known_face' | 'unknown_face' | undefined;
  unknown_only?: boolean | undefined;
  min_confidence?: number | undefined;
  max_confidence?: number | undefined;
  start_date?: string | undefined;
  end_date?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

export async function listRecognitionEvents(
  db: Sql,
  orgId: string,
  filters: ListEventsFilters,
): Promise<CursorPaginatedResult> {
  const cameraFilter = filters.camera_id ? db`AND camera_id = ${filters.camera_id}` : db``;
  const faceProfileFilter = filters.face_profile_id ? db`AND face_profile_id = ${filters.face_profile_id}` : db``;
  const eventTypeFilter = (filters.event_type || filters.unknown_only)
    ? db`AND event_type = ${filters.unknown_only ? 'unknown_face' : filters.event_type!}`
    : db``;
  const minConfFilter = filters.min_confidence !== undefined ? db`AND confidence >= ${filters.min_confidence}` : db``;
  const maxConfFilter = filters.max_confidence !== undefined ? db`AND confidence <= ${filters.max_confidence}` : db``;
  const startDateFilter = filters.start_date ? db`AND created_at >= ${filters.start_date}` : db``;
  const endDateFilter = filters.end_date ? db`AND created_at <= ${filters.end_date}` : db``;
  const cursorFilter = filters.cursor ? db`AND id < ${filters.cursor}` : db``;

  const limit = filters.limit + 1;

  const rows = await db<RecognitionEvent[]>`
    SELECT * FROM recognition_events
    WHERE org_id = ${orgId}
    ${cameraFilter}
    ${faceProfileFilter}
    ${eventTypeFilter}
    ${minConfFilter}
    ${maxConfFilter}
    ${startDateFilter}
    ${endDateFilter}
    ${cursorFilter}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `;

  const hasMore = rows.length > filters.limit;
  const items = hasMore ? rows.slice(0, filters.limit) : rows;
  const data = await Promise.all(items.map(toResponse));
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null;

  return {
    data,
    pagination: { cursor: nextCursor, has_more: hasMore },
  };
}

export async function getRecognitionEventById(
  db: Sql,
  orgId: string,
  eventId: string,
): Promise<RecognitionEventResponse> {
  const rows = await db<RecognitionEvent[]>`
    SELECT * FROM recognition_events WHERE id = ${eventId} AND org_id = ${orgId}
  `;
  const event = rows[0];
  if (!event) throw AppError.notFound('Recognition event not found');
  return toResponse(event);
}
