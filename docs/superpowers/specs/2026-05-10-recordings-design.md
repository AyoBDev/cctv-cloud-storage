# Recordings — Design Spec

**Date:** 2026-05-10
**Scope:** Sprint 5 — Continuous archival of KVS streams to S3 + recordings API
**Approach:** Scheduled Lambda archives 5-minute MP4 clips from KVS to S3; API serves clip metadata and pre-signed playback URLs

---

## 1. Database Schema

### Migration `008_recordings.ts`

**`recordings` table:**

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default gen_random_uuid() |
| org_id | uuid | FK → organizations, NOT NULL |
| camera_id | uuid | FK → cameras, NOT NULL |
| s3_key | text | Full S3 object key, NOT NULL |
| start_time | timestamptz | Start of the 5-min window, NOT NULL |
| end_time | timestamptz | End of the 5-min window, NOT NULL |
| duration_seconds | integer | Actual duration (may be < 300 if camera went offline mid-window) |
| file_size_bytes | bigint | File size for display/billing |
| created_at | timestamptz | default now() |

- Index on `(org_id, camera_id, start_time DESC)` for paginated listing
- Index on `(camera_id, start_time)` for dedup checks
- Unique constraint on `(camera_id, start_time)` to prevent duplicate clips

---

## 2. S3 Structure & Lifecycle

### Object Path

```
orgs/{orgId}/cameras/{cameraId}/{YYYY-MM-DD}/{HH-mm}.mp4
```

Example: `orgs/abc123/cameras/def456/2026-05-10/14-30.mp4`

### Lifecycle Policy

- **Standard storage:** First 30 days
- **Glacier Instant Retrieval:** After 30 days (sub-second access, cheaper storage)
- **Delete:** After 365 days (configurable per org in future, hardcoded for MVP)

The S3 lifecycle rule is applied at the bucket level with prefix `orgs/` via Terraform.

### Bucket

Uses the existing `cctv-staging-media` bucket (same as face profiles). Recordings go under the `orgs/` prefix.

---

## 3. Archival Lambda

### Location: `lambda/recording-archiver/`

Separate Lambda from face recognition — different trigger, different purpose, different memory/timeout profile.

### Trigger

EventBridge rule: `rate(5 minutes)`

### Flow

1. Receive scheduled event
2. Query the API's internal endpoint `GET /internal/cameras/active` to get all active cameras with their KVS stream names and org IDs
3. For each active camera:
   a. Calculate time window: `end = now()` rounded down to nearest 5-min boundary, `start = end - 5 minutes`
   b. Call KVS `GetDataEndpoint` (with API_NAME `GET_CLIP`)
   c. Call KVS Archived Media `GetClip` with the time window (container format: MP4)
   d. Upload the resulting MP4 to S3 at the computed key
   e. POST to `/internal/recordings` with clip metadata (org_id, camera_id, s3_key, start_time, end_time, duration, file_size)
4. Return success

### Error Handling

- Camera stream has no data in window (offline) → skip silently, no recording created
- KVS throttling → retry with exponential backoff (max 2 retries)
- Single camera failure does not abort other cameras
- Errors logged to CloudWatch

### Performance

- Timeout: 120s (needs more time than face recognition — multiple camera downloads)
- Memory: 1024MB (buffering MP4 clips in memory)
- Concurrency: Process cameras sequentially within a single invocation (avoid KVS rate limits)
- For large deployments (>50 cameras), would need fan-out via SQS — out of scope for MVP

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `INTERNAL_API_URL` | Base URL of the API (ALB DNS) |
| `SSM_PREFIX` | SSM path for internal secret |
| `MEDIA_BUCKET` | S3 bucket name |
| `AWS_REGION` | AWS region |

---

## 4. Internal Endpoints

### `GET /internal/cameras/active`

Returns all active cameras with stream info. Used by the archival Lambda.

**Auth:** `x-internal-secret` header

**Response:**
```json
{
  "cameras": [
    {
      "id": "uuid",
      "org_id": "uuid",
      "kvs_stream_name": "org-slug-camera-slug",
      "kvs_stream_arn": "arn:..."
    }
  ]
}
```

### `POST /internal/recordings`

Creates a recording metadata record. Used by the archival Lambda after uploading a clip.

**Auth:** `x-internal-secret` header

**Request:**
```json
{
  "org_id": "uuid",
  "camera_id": "uuid",
  "s3_key": "orgs/{orgId}/cameras/{cameraId}/2026-05-10/14-30.mp4",
  "start_time": "2026-05-10T14:30:00Z",
  "end_time": "2026-05-10T14:35:00Z",
  "duration_seconds": 300,
  "file_size_bytes": 15728640
}
```

**Response:** `201` with the created recording object

---

## 5. Public Recordings Routes

### `GET /api/v1/cameras/:cameraId/recordings`

List recordings for a specific camera, filtered by date range.

**Auth:** `requireUser` — viewers only see recordings for assigned cameras

**Query params:**

| Param | Type | Description |
|-------|------|-------------|
| start_date | ISO string | Start of date range (required) |
| end_date | ISO string | End of date range (required) |
| cursor | string | Cursor for pagination (recording ID) |
| limit | number | Default 50, max 200 |

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "camera_id": "uuid",
      "start_time": "2026-05-10T14:30:00Z",
      "end_time": "2026-05-10T14:35:00Z",
      "duration_seconds": 300,
      "file_size_bytes": 15728640,
      "created_at": "2026-05-10T14:35:12Z"
    }
  ],
  "pagination": { "cursor": "uuid | null", "has_more": true }
}
```

Ordered by `start_time DESC` (most recent first).

### `GET /api/v1/cameras/:cameraId/recordings/:recordingId`

Get a single recording with a pre-signed playback URL.

**Auth:** `requireUser` — viewers only see recordings for assigned cameras

**Response:**
```json
{
  "id": "uuid",
  "camera_id": "uuid",
  "start_time": "2026-05-10T14:30:00Z",
  "end_time": "2026-05-10T14:35:00Z",
  "duration_seconds": 300,
  "file_size_bytes": 15728640,
  "playback_url": "https://s3.amazonaws.com/... (pre-signed, 1-hour TTL)",
  "created_at": "2026-05-10T14:35:12Z"
}
```

---

## 6. KVS Retention Update

The `createCamera` function currently sets KVS `DataRetentionInHours: 24`. This must be updated to **48 hours** to provide a retry buffer for the archival Lambda.

Existing cameras will need a one-time update via `UpdateDataRetention` — but this can be handled manually or as a migration script, not as part of the API code.

---

## 7. Recording Service (`src/services/recording.service.ts`)

| Method | Purpose |
|--------|---------|
| `createRecording(db, data)` | Insert recording metadata from Lambda |
| `listRecordings(db, orgId, cameraId, startDate, endDate, cursor, limit)` | Cursor-paginated list with date filtering |
| `getRecordingById(db, orgId, cameraId, recordingId)` | Single recording with pre-signed URL |
| `getActiveCameras(db)` | List all active cameras for the archival Lambda |

---

## 8. Environment Config

### New Variables (`src/config/env.ts`)

No new env vars needed — `S3_MEDIA_BUCKET` already exists and will be reused for recordings.

### Route Registration (`src/routes/index.ts`)

Recording routes are nested under cameras:
```typescript
// Already registered under /api/v1/cameras
// Recordings are at /api/v1/cameras/:cameraId/recordings
```

The recordings routes register as a sub-plugin of camera routes (like viewers).

### Internal Route

```typescript
app.register(internalRecordingRoutes) // path: /internal/recordings, /internal/cameras/active
```

---

## 9. Terraform Changes

### New Lambda (`terraform/modules/lambda/`)

Add a second Lambda function for the recording archiver:

- **Name:** `{project}-{environment}-recording-archiver`
- **Runtime:** Node.js 20.x
- **Timeout:** 120s
- **Memory:** 1024MB
- **Trigger:** EventBridge `rate(5 minutes)`
- **VPC:** Same private subnets as face recognition Lambda

### S3 Lifecycle Rule

Add to the storage module:
```hcl
lifecycle_rule {
  id      = "recordings-glacier"
  prefix  = "orgs/"
  enabled = true

  transition {
    days          = 30
    storage_class = "GLACIER_IR"
  }

  expiration {
    days = 365
  }
}
```

---

## 10. Permissions Summary

| Action | Viewer | Org Admin |
|--------|--------|-----------|
| List recordings (assigned cameras) | Yes | Yes |
| View/play recording (assigned cameras) | Yes | Yes |
| List recordings (all org cameras) | No | Yes |
| View/play recording (all org cameras) | No | Yes |

Viewers are restricted to cameras assigned via `camera_assignments` (same pattern as stream and credentials endpoints).

---

## 11. Testing Strategy

### Unit Tests

| Test File | Coverage |
|-----------|----------|
| `tests/recordings/recordings.test.ts` | List with date filters, cursor pagination, playback URL generation, org scoping |
| `tests/recordings/recording-permissions.test.ts` | Viewer can only access assigned camera recordings, admin sees all |
| `tests/internal/recordings.test.ts` | Create recording via internal endpoint, get active cameras |
| `tests/recordings/cross-org-isolation.test.ts` | Org A cannot see Org B's recordings |

### Lambda Tests

`lambda/recording-archiver/__tests__/handler.test.ts` — Unit tests with mocked KVS, S3, HTTP.

### AWS Mocking

Same pattern as face recognition: in test env (`NODE_ENV === 'test'`), service layer returns mock data without calling AWS.

---

## 12. Key Design Decisions

1. **Separate Lambda from face recognition** — Different resource profile (more memory, longer timeout), different trigger schedule, independent failure domains
2. **5-minute aligned windows** — Clips always start at :00, :05, :10, etc. Simplifies dedup and seeking
3. **Internal API for metadata persistence** — Lambda stays thin (download + upload), API owns DB writes
4. **Cursor pagination** — Consistent with recognition events; better for large result sets than page/offset
5. **Pre-signed URL on detail only** — List endpoint doesn't include playback URLs (expensive to generate for many clips); only the detail endpoint generates one on demand
6. **Reuse existing S3 bucket** — No need for a separate recordings bucket; prefix-based separation is sufficient
7. **48-hour KVS retention** — Provides buffer for Lambda failures; clips are the permanent archive
