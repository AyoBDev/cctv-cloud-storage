import type { Sql } from 'postgres';
import { AppError } from '@utils/errors';

export interface FaceDetectionSettings {
  enabled: boolean;
  schedule: { start_time: string; end_time: string } | null;
  duration_until: string | null;
}

export interface CameraFaceDetectionResponse {
  camera_override: {
    enabled: boolean | null;
    schedule: { start_time: string; end_time: string } | null;
    duration_until: string | null;
  };
  effective: {
    enabled: boolean;
    schedule: { start_time: string; end_time: string } | null;
    active_now: boolean;
  };
}

export interface UpdateFaceDetectionInput {
  enabled?: boolean | null | undefined;
  duration_minutes?: number | null | undefined;
  schedule?: { start_time: string; end_time: string } | null | undefined;
}

function formatTimeForDb(hhmm: string): string {
  return `${hhmm}:00`;
}

function formatTimeForResponse(time: string | null): string | null {
  if (!time) return null;
  return time.substring(0, 5);
}

export async function getOrgFaceDetectionSettings(
  db: Sql,
  orgId: string,
): Promise<FaceDetectionSettings> {
  const rows = await db<
    Array<{
      face_detection_enabled: boolean;
      face_detection_start_time: string | null;
      face_detection_end_time: string | null;
      face_detection_duration_until: string | null;
    }>
  >`
    SELECT face_detection_enabled, face_detection_start_time,
           face_detection_end_time, face_detection_duration_until
    FROM organizations
    WHERE id = ${orgId}
  `;

  const org = rows[0];
  if (!org) throw AppError.notFound('Organization not found');

  const startTime = formatTimeForResponse(org.face_detection_start_time);
  const endTime = formatTimeForResponse(org.face_detection_end_time);

  return {
    enabled: org.face_detection_enabled,
    schedule: startTime && endTime ? { start_time: startTime, end_time: endTime } : null,
    duration_until: org.face_detection_duration_until,
  };
}

export async function updateOrgFaceDetectionSettings(
  db: Sql,
  orgId: string,
  input: UpdateFaceDetectionInput,
): Promise<FaceDetectionSettings> {
  const current = await db<
    Array<{
      face_detection_enabled: boolean;
      face_detection_start_time: string | null;
      face_detection_end_time: string | null;
      face_detection_duration_until: string | null;
    }>
  >`
    SELECT face_detection_enabled, face_detection_start_time,
           face_detection_end_time, face_detection_duration_until
    FROM organizations WHERE id = ${orgId}
  `;
  if (!current[0]) throw AppError.notFound('Organization not found');

  let enabled = current[0].face_detection_enabled;
  let startTime: string | null = current[0].face_detection_start_time;
  let endTime: string | null = current[0].face_detection_end_time;
  let durationUntil: string | null = current[0].face_detection_duration_until;

  if (input.enabled === false) {
    enabled = false;
    startTime = null;
    endTime = null;
    durationUntil = null;
  } else if (input.enabled === true) {
    enabled = true;
  }

  if (input.schedule !== undefined) {
    if (input.schedule === null) {
      startTime = null;
      endTime = null;
    } else {
      startTime = formatTimeForDb(input.schedule.start_time);
      endTime = formatTimeForDb(input.schedule.end_time);
    }
  }

  if (input.duration_minutes !== undefined) {
    if (input.duration_minutes === null) {
      durationUntil = null;
    } else {
      const until = new Date(Date.now() + input.duration_minutes * 60 * 1000);
      durationUntil = until.toISOString();
    }
  }

  const rows = await db<
    Array<{
      face_detection_enabled: boolean;
      face_detection_start_time: string | null;
      face_detection_end_time: string | null;
      face_detection_duration_until: string | null;
    }>
  >`
    UPDATE organizations
    SET face_detection_enabled = ${enabled},
        face_detection_start_time = ${startTime}::time,
        face_detection_end_time = ${endTime}::time,
        face_detection_duration_until = ${durationUntil}::timestamptz
    WHERE id = ${orgId}
    RETURNING face_detection_enabled, face_detection_start_time,
              face_detection_end_time, face_detection_duration_until
  `;

  const org = rows[0];
  if (!org) throw AppError.notFound('Organization not found');

  const st = formatTimeForResponse(org.face_detection_start_time);
  const et = formatTimeForResponse(org.face_detection_end_time);

  return {
    enabled: org.face_detection_enabled,
    schedule: st && et ? { start_time: st, end_time: et } : null,
    duration_until: org.face_detection_duration_until,
  };
}

export async function getCameraFaceDetectionSettings(
  db: Sql,
  orgId: string,
  cameraId: string,
): Promise<CameraFaceDetectionResponse> {
  const rows = await db<
    Array<{
      cam_enabled: boolean | null;
      cam_start_time: string | null;
      cam_end_time: string | null;
      cam_duration_until: string | null;
      cam_timezone: string;
      org_enabled: boolean;
      org_start_time: string | null;
      org_end_time: string | null;
      org_duration_until: string | null;
    }>
  >`
    SELECT
      c.face_detection_enabled AS cam_enabled,
      c.face_detection_start_time AS cam_start_time,
      c.face_detection_end_time AS cam_end_time,
      c.face_detection_duration_until AS cam_duration_until,
      c.timezone AS cam_timezone,
      o.face_detection_enabled AS org_enabled,
      o.face_detection_start_time AS org_start_time,
      o.face_detection_end_time AS org_end_time,
      o.face_detection_duration_until AS org_duration_until
    FROM cameras c
    JOIN organizations o ON o.id = c.org_id
    WHERE c.id = ${cameraId} AND c.org_id = ${orgId} AND c.is_active = true
  `;

  const row = rows[0];
  if (!row) throw AppError.notFound('Camera not found');

  const camStart = formatTimeForResponse(row.cam_start_time);
  const camEnd = formatTimeForResponse(row.cam_end_time);

  const cameraOverride = {
    enabled: row.cam_enabled,
    schedule: camStart && camEnd ? { start_time: camStart, end_time: camEnd } : null,
    duration_until: row.cam_duration_until,
  };

  const useCamera = row.cam_enabled !== null;
  const effectiveEnabled = useCamera ? row.cam_enabled! : row.org_enabled;
  const effectiveStartTime = useCamera ? row.cam_start_time : row.org_start_time;
  const effectiveEndTime = useCamera ? row.cam_end_time : row.org_end_time;
  const effectiveDurationUntil = useCamera ? row.cam_duration_until : row.org_duration_until;

  const effStart = formatTimeForResponse(effectiveStartTime);
  const effEnd = formatTimeForResponse(effectiveEndTime);
  const effectiveSchedule = effStart && effEnd ? { start_time: effStart, end_time: effEnd } : null;

  const activeNow = computeActiveNow(
    effectiveEnabled,
    effectiveDurationUntil,
    effectiveSchedule,
    row.cam_timezone,
  );

  return {
    camera_override: cameraOverride,
    effective: {
      enabled: effectiveEnabled,
      schedule: effectiveSchedule,
      active_now: activeNow,
    },
  };
}

export async function updateCameraFaceDetectionSettings(
  db: Sql,
  orgId: string,
  cameraId: string,
  input: UpdateFaceDetectionInput,
): Promise<CameraFaceDetectionResponse> {
  const current = await db<
    Array<{
      face_detection_enabled: boolean | null;
      face_detection_start_time: string | null;
      face_detection_end_time: string | null;
      face_detection_duration_until: string | null;
    }>
  >`
    SELECT face_detection_enabled, face_detection_start_time,
           face_detection_end_time, face_detection_duration_until
    FROM cameras WHERE id = ${cameraId} AND org_id = ${orgId} AND is_active = true
  `;
  if (!current[0]) throw AppError.notFound('Camera not found');

  let enabled: boolean | null = current[0].face_detection_enabled;
  let startTime: string | null = current[0].face_detection_start_time;
  let endTime: string | null = current[0].face_detection_end_time;
  let durationUntil: string | null = current[0].face_detection_duration_until;

  if (input.enabled === false) {
    enabled = false;
    startTime = null;
    endTime = null;
    durationUntil = null;
  } else if (input.enabled === true) {
    enabled = true;
  } else if (input.enabled === null) {
    enabled = null;
    startTime = null;
    endTime = null;
    durationUntil = null;
  }

  if (input.schedule !== undefined && input.enabled !== false && input.enabled !== null) {
    if (input.schedule === null) {
      startTime = null;
      endTime = null;
    } else {
      startTime = formatTimeForDb(input.schedule.start_time);
      endTime = formatTimeForDb(input.schedule.end_time);
    }
  }

  if (input.duration_minutes !== undefined && input.enabled !== false && input.enabled !== null) {
    if (input.duration_minutes === null) {
      durationUntil = null;
    } else {
      const until = new Date(Date.now() + input.duration_minutes * 60 * 1000);
      durationUntil = until.toISOString();
    }
  }

  await db`
    UPDATE cameras
    SET face_detection_enabled = ${enabled},
        face_detection_start_time = ${startTime}::time,
        face_detection_end_time = ${endTime}::time,
        face_detection_duration_until = ${durationUntil}::timestamptz
    WHERE id = ${cameraId} AND org_id = ${orgId} AND is_active = true
  `;

  return getCameraFaceDetectionSettings(db, orgId, cameraId);
}

export async function isFaceDetectionActive(db: Sql, cameraId: string): Promise<boolean> {
  const rows = await db<
    Array<{
      cam_enabled: boolean | null;
      cam_start_time: string | null;
      cam_end_time: string | null;
      cam_duration_until: string | null;
      cam_timezone: string;
      org_enabled: boolean;
      org_start_time: string | null;
      org_end_time: string | null;
      org_duration_until: string | null;
    }>
  >`
    SELECT
      c.face_detection_enabled AS cam_enabled,
      c.face_detection_start_time AS cam_start_time,
      c.face_detection_end_time AS cam_end_time,
      c.face_detection_duration_until AS cam_duration_until,
      c.timezone AS cam_timezone,
      o.face_detection_enabled AS org_enabled,
      o.face_detection_start_time AS org_start_time,
      o.face_detection_end_time AS org_end_time,
      o.face_detection_duration_until AS org_duration_until
    FROM cameras c
    JOIN organizations o ON o.id = c.org_id
    WHERE c.id = ${cameraId} AND c.is_active = true
  `;

  const row = rows[0];
  if (!row) return false;

  const useCamera = row.cam_enabled !== null;
  const effectiveEnabled = useCamera ? row.cam_enabled! : row.org_enabled;
  const effectiveStartTime = useCamera ? row.cam_start_time : row.org_start_time;
  const effectiveEndTime = useCamera ? row.cam_end_time : row.org_end_time;
  const effectiveDurationUntil = useCamera ? row.cam_duration_until : row.org_duration_until;

  const effStart = formatTimeForResponse(effectiveStartTime);
  const effEnd = formatTimeForResponse(effectiveEndTime);
  const effectiveSchedule = effStart && effEnd ? { start_time: effStart, end_time: effEnd } : null;

  return computeActiveNow(
    effectiveEnabled,
    effectiveDurationUntil,
    effectiveSchedule,
    row.cam_timezone,
  );
}

export function computeActiveNow(
  enabled: boolean,
  durationUntil: string | null,
  schedule: { start_time: string; end_time: string } | null,
  timezone: string,
): boolean {
  if (!enabled) return false;

  if (durationUntil) {
    const until = new Date(durationUntil);
    if (Date.now() > until.getTime()) return false;
  }

  if (schedule) {
    return isWithinSchedule(schedule.start_time, schedule.end_time, timezone);
  }

  return true;
}

function isWithinSchedule(startTime: string, endTime: string, timezone: string): boolean {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const nowTimeStr = formatter.format(now);
  const nowMinutes = timeToMinutes(nowTimeStr);
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);

  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  } else {
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours! * 60 + minutes!;
}
