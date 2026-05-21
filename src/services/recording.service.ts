import type { Sql } from 'postgres';
import { getSignedUrl } from '@services/s3.service';
import { AppError } from '@utils/errors';

export interface Recording {
  id: string;
  org_id: string;
  camera_id: string;
  s3_key: string;
  start_time: Date;
  end_time: Date;
  duration_seconds: number;
  file_size_bytes: string; // bigint comes as string from postgres
  created_at: Date;
}

export interface RecordingListItem {
  id: string;
  camera_id: string;
  start_time: Date;
  end_time: Date;
  duration_seconds: number;
  file_size_bytes: number;
  playback_url: string;
  created_at: Date;
}

export interface RecordingDetail extends RecordingListItem {
  playback_url: string;
}

export interface CursorPaginatedRecordings {
  data: RecordingListItem[];
  pagination: { cursor: string | null; has_more: boolean };
}

export interface RecordingDownload {
  download_url: string;
  file_name: string;
  file_size_bytes: number;
  content_type: string;
}

export interface CreateRecordingInput {
  org_id: string;
  camera_id: string;
  s3_key: string;
  start_time: string;
  end_time: string;
  duration_seconds: number;
  file_size_bytes: number;
}

export interface ActiveCamera {
  id: string;
  org_id: string;
  kvs_stream_name: string;
  kvs_stream_arn: string | null;
}

async function toListItem(row: Recording): Promise<RecordingListItem> {
  const playbackUrl = await getSignedUrl(row.s3_key, 3600);
  return {
    id: row.id,
    camera_id: row.camera_id,
    start_time: row.start_time,
    end_time: row.end_time,
    duration_seconds: row.duration_seconds,
    file_size_bytes: Number(row.file_size_bytes),
    playback_url: playbackUrl,
    created_at: row.created_at,
  };
}

export async function createRecording(
  db: Sql,
  input: CreateRecordingInput,
): Promise<RecordingListItem> {
  const rows = await db<Recording[]>`
    INSERT INTO recordings (org_id, camera_id, s3_key, start_time, end_time, duration_seconds, file_size_bytes)
    VALUES (
      ${input.org_id},
      ${input.camera_id},
      ${input.s3_key},
      ${input.start_time},
      ${input.end_time},
      ${input.duration_seconds},
      ${input.file_size_bytes}
    )
    ON CONFLICT (camera_id, start_time) DO NOTHING
    RETURNING *
  `;

  const recording = rows[0];
  if (!recording) {
    const existing = await db<Recording[]>`
      SELECT * FROM recordings WHERE camera_id = ${input.camera_id} AND start_time = ${input.start_time}
    `;
    return toListItem(existing[0]!);
  }

  return toListItem(recording);
}

export async function getRecordingDownload(
  db: Sql,
  orgId: string,
  cameraId: string,
  recordingId: string,
): Promise<RecordingDownload> {
  const rows = await db<Recording[]>`
    SELECT * FROM recordings
    WHERE id = ${recordingId} AND org_id = ${orgId} AND camera_id = ${cameraId}
  `;

  const recording = rows[0];
  if (!recording) throw AppError.notFound('Recording not found');

  const downloadUrl = await getSignedUrl(recording.s3_key, 3600);
  const fileName = recording.s3_key.split('/').pop() ?? `recording-${recordingId}.mp4`;

  return {
    download_url: downloadUrl,
    file_name: fileName,
    file_size_bytes: Number(recording.file_size_bytes),
    content_type: 'video/mp4',
  };
}

export async function listRecordings(
  db: Sql,
  orgId: string,
  cameraId: string,
  startDate: string,
  endDate: string,
  cursor: string | undefined,
  limit: number,
): Promise<CursorPaginatedRecordings> {
  const cursorFilter = cursor ? db`AND r.id < ${cursor}` : db``;
  const fetchLimit = limit + 1;

  const rows = await db<Recording[]>`
    SELECT r.* FROM recordings r
    JOIN cameras c ON c.id = r.camera_id AND c.org_id = ${orgId}
    WHERE r.camera_id = ${cameraId}
      AND r.org_id = ${orgId}
      AND r.start_time >= ${startDate}
      AND r.start_time <= ${endDate}
      ${cursorFilter}
    ORDER BY r.start_time DESC, r.id DESC
    LIMIT ${fetchLimit}
  `;

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const data = await Promise.all(items.map(toListItem));
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null;

  return {
    data,
    pagination: { cursor: nextCursor, has_more: hasMore },
  };
}

export async function getRecordingById(
  db: Sql,
  orgId: string,
  cameraId: string,
  recordingId: string,
): Promise<RecordingDetail> {
  const rows = await db<Recording[]>`
    SELECT * FROM recordings
    WHERE id = ${recordingId} AND org_id = ${orgId} AND camera_id = ${cameraId}
  `;

  const recording = rows[0];
  if (!recording) throw AppError.notFound('Recording not found');

  const item = await toListItem(recording);
  return {
    ...item,
    playback_url: item.playback_url,
  };
}

export async function getActiveCameras(db: Sql): Promise<ActiveCamera[]> {
  const rows = await db<ActiveCamera[]>`
    SELECT id, org_id, kvs_stream_name, kvs_stream_arn
    FROM cameras
    WHERE is_active = true AND status = 'online'
  `;
  return rows;
}
