# Facial Recognition with AWS Rekognition — Design Spec

**Date:** 2026-05-09
**Scope:** Sprint 6 (Face Profiles + Rekognition) and Sprint 7 (Recognition Events + Lambda Pipeline)
**Approach:** Pipeline with Separation of Concerns — Lambda handles frame extraction + face search, API handles business logic (dedup, alerting, persistence)

---

## 1. Database Schema

### Migration `006_face_profiles.ts`

**`face_profiles` table:**

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default gen_random_uuid() |
| org_id | uuid | FK → organizations, NOT NULL |
| face_id | varchar(255) | Rekognition FaceId from IndexFaces |
| label | varchar(255) | Human-readable name (e.g., "John Smith") |
| image_key | text | S3 object key for the source image |
| created_by | uuid | FK → users (who uploaded it) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

- Index on `(org_id)` for list queries
- Unique constraint on `face_id`

### Migration `007_recognition_events.ts`

**`event_type_enum`:** Postgres enum with values `known_face`, `unknown_face`

**`recognition_events` table:**

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default gen_random_uuid() |
| org_id | uuid | FK → organizations, NOT NULL |
| camera_id | uuid | FK → cameras, NOT NULL |
| face_profile_id | uuid | FK → face_profiles, nullable (null = unknown) |
| event_type | event_type_enum | `known_face` or `unknown_face` |
| confidence | decimal(5,2) | Rekognition confidence score |
| thumbnail_key | text | S3 key for event thumbnail |
| unknown_face_id | varchar(255) | FaceId from temp unknown collection (for dedup) |
| created_at | timestamptz | default now() |

- Index on `(org_id, created_at DESC)` for paginated listing
- Index on `(org_id, camera_id)`
- Index on `(org_id, face_profile_id)`

---

## 2. AWS Clients & Services

### AWS Plugin Updates (`src/plugins/aws.ts`)

Add `RekognitionClient` and `S3Client` to the existing plugin. Decorate Fastify instance with both. In test env (`NODE_ENV === 'test'`), service layer skips AWS calls (same pattern as KVS/KMS).

### Rekognition Service (`src/services/rekognition.service.ts`)

| Method | Purpose |
|--------|---------|
| `createCollection(orgId)` | Creates `collection-{orgId}` — lazy on first face upload |
| `deleteCollection(orgId)` | Deletes collection on org teardown |
| `indexFace(orgId, imageBytes)` | IndexFaces into `collection-{orgId}`, returns FaceId |
| `deleteFace(orgId, faceId)` | DeleteFaces from the org's collection |
| `searchByImage(orgId, imageBytes, threshold)` | SearchFacesByImage, 80% default threshold |
| `indexUnknownFace(orgId, imageBytes)` | IndexFaces into `unknown-{orgId}` temp collection |
| `searchUnknownByImage(orgId, imageBytes)` | SearchFacesByImage against `unknown-{orgId}` for 24h dedup |
| `purgeExpiredUnknowns(orgId)` | ListFaces in `unknown-{orgId}`, delete faces > 24h old |

### S3 Service (`src/services/s3.service.ts`)

| Method | Purpose |
|--------|---------|
| `uploadFaceImage(orgId, profileId, buffer, mimeType)` | `orgs/{orgId}/face-profiles/{profileId}/original.{ext}` |
| `uploadEventThumbnail(orgId, eventId, buffer)` | `recognition-events/{orgId}/{eventId}/thumb.jpg` |
| `getSignedUrl(key, ttl)` | Pre-signed GET URL (1-hr TTL) |
| `deleteObject(key)` | Remove object from S3 |

### Collection Lifecycle

| Collection | Created | Deleted |
|------------|---------|---------|
| `collection-{orgId}` | Lazily on first face profile upload | On org deletion |
| `unknown-{orgId}` | Lazily on first unknown face detection | Never deleted; faces purged individually after 24h |

---

## 3. Face Profile Routes

### Endpoints (`src/routes/face-profiles/index.ts`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/face-profiles` | requireUser (any org user) | Upload face image, index in Rekognition |
| GET | `/api/v1/face-profiles` | requireUser | List face profiles (paginated, org-scoped) |
| GET | `/api/v1/face-profiles/:id` | requireUser | Get single profile with signed image URL |
| DELETE | `/api/v1/face-profiles/:id` | requireOrgAdmin | Delete profile, remove from Rekognition + S3 |

### POST `/api/v1/face-profiles`

**Request:** Multipart form-data
- `image` (file, required) — JPEG/PNG, max 5MB, min 80x80px
- `label` (string, required) — Name/label for the face

**Flow:**
1. Validate file type, size, dimensions
2. Ensure collection exists (lazy create `collection-{orgId}`)
3. Call `IndexFaces` — if no face detected or multiple faces detected, return 400
4. Upload image to S3
5. Insert record in `face_profiles` table
6. Return profile object

**Response:** `201` with `{ id, label, face_id, image_url (signed), created_at }`

**Error cases:**
- 400: Invalid image format/size, no face detected, multiple faces detected
- 409: Face already indexed (duplicate FaceId)

### GET `/api/v1/face-profiles`

**Query params:** `page`, `limit` (default 20, max 100)
**Response:** `{ data: [...], pagination: { page, limit, total } }` — each item includes signed image URL

### GET `/api/v1/face-profiles/:id`

**Response:** Full profile with signed image URL, or 404

### DELETE `/api/v1/face-profiles/:id`

**Flow:**
1. Verify profile belongs to `req.user.org_id`
2. Call `DeleteFaces` on Rekognition collection
3. Delete S3 image
4. Delete DB record
5. Return 204

### Face Profile Service (`src/services/face-profile.service.ts`)

Orchestrates business logic — calls Rekognition service, S3 service, and DB. Keeps route handlers thin.

---

## 4. Recognition Events

### Internal Endpoint (`src/routes/internal/recognition-events/index.ts`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/internal/recognition-events` | requireInternalSecret | Lambda posts detection results |

**Request body:**
```json
{
  "org_id": "uuid",
  "camera_id": "uuid",
  "image_bytes": "base64-encoded frame",
  "confidence": 92.5,
  "face_profile_id": "uuid | null",
  "event_type": "known_face | unknown_face"
}
```

**Flow:**
1. Validate payload
2. If `event_type === "unknown_face"`:
   - Call `searchUnknownByImage(orgId, imageBytes)` against `unknown-{orgId}` collection
   - If match found (seen in last 24h) → persist event, **skip alerting**
   - If no match → call `indexUnknownFace(orgId, imageBytes)`, persist event, **trigger alert**
3. If `event_type === "known_face"`:
   - Persist event directly (no alerting)
4. Upload thumbnail to S3
5. Insert into `recognition_events` table
6. Return 201

### Alert Logic

- Check Redis key `alert:{orgId}:{cameraId}:{unknownFaceId}`
- If key doesn't exist → send SES email to org admin, set key with 5-min TTL (debounce)
- Email contains: camera name, thumbnail, timestamp, link to events feed

### Public Routes (`src/routes/recognition-events/index.ts`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/recognition-events` | requireUser | List events (filtered, cursor-paginated) |
| GET | `/api/v1/recognition-events/:id` | requireUser | Single event with signed thumbnail URL |

### GET `/api/v1/recognition-events` Filters

| Param | Type | Description |
|-------|------|-------------|
| `camera_id` | uuid | Filter by camera |
| `face_profile_id` | uuid | Filter by known face |
| `event_type` | enum | `known_face` or `unknown_face` |
| `unknown_only` | boolean | Shortcut for `event_type=unknown_face` |
| `min_confidence` | number | Minimum confidence score |
| `max_confidence` | number | Maximum confidence score |
| `start_date` | ISO string | Start of date range |
| `end_date` | ISO string | End of date range |
| `cursor` | string | Cursor for pagination (event ID) |
| `limit` | number | Default 20, max 100 |

**Response:** `{ data: [...], pagination: { cursor, has_more } }`

---

## 5. Lambda Handler

### Location: `lambda/face-recognition/index.ts`

**Trigger:** KVS fragment notification

**Flow:**
1. Receive KVS fragment event
2. Extract stream ARN → derive `orgId` and `cameraId` from stream name (`{orgId}-{cameraId}`)
3. Call `GetMedia` to retrieve the fragment
4. Extract a single JPEG frame (ffmpeg Lambda layer)
5. Call `SearchFacesByImage` against `collection-{orgId}` with 80% threshold
6. Build result:
   - Match found → `event_type: "known_face"`, `face_profile_id`, confidence
   - No match → `event_type: "unknown_face"`, include base64 image bytes
7. POST to `{INTERNAL_API_URL}/internal/recognition-events` with `x-internal-secret` header
8. Return success

**Error handling:**
- No face in frame → skip silently
- Rekognition throttling → retry with backoff (max 2 retries)
- API unreachable → log error, Lambda retry policy handles it

**Performance:**
- SSM parameter (internal secret) cached at cold start
- Frame sampling: 1 frame every 5 seconds to control cost
- Timeout: 30s, Memory: 512MB

### Deployment

- Code in `lambda/face-recognition/` at project root
- Deployed via CI (separate from API Docker image)
- Terraform ignores `filename`/`source_code_hash` (external deploy)

---

## 6. Unknown Face Purge

### Mechanism: Scheduled EventBridge Rule (hourly)

- EventBridge rule: `rate(1 hour)` triggers the same face-recognition Lambda
- Lambda checks event shape: KVS fragment → recognition flow, purge event (`{ "action": "purge_unknowns" }`) → cleanup flow
- Purge logic: query DB for distinct org_ids from `recognition_events` where `event_type = 'unknown_face'` and `created_at > now() - 24h`, then for each `unknown-{orgId}` collection, `ListFaces`, delete faces > 24h old
- Age determined via `ExternalImageId` field (format: `unknown-{unix_timestamp}`)

### Terraform Addition

- EventBridge rule + Lambda permission (added to existing `terraform/modules/lambda/`)

---

## 7. Environment Config

### New Variables (`src/config/env.ts`)

| Variable | Purpose | Default |
|----------|---------|---------|
| `REKOGNITION_COLLECTION_PREFIX` | Prefix for known collections | `collection-` |
| `REKOGNITION_UNKNOWN_PREFIX` | Prefix for unknown collections | `unknown-` |
| `REKOGNITION_MATCH_THRESHOLD` | Confidence threshold | `80` |
| `S3_MEDIA_BUCKET` | Bucket for face images + thumbnails | required |
| `SES_FROM_EMAIL` | Sender email for alerts | required |
| `SES_REGION` | SES region | `eu-west-2` |
| `UNKNOWN_FACE_TTL_HOURS` | Retention for unknowns | `24` |
| `ALERT_DEBOUNCE_SECONDS` | Alert cooldown per camera per face | `300` |

### Route Registration (`src/routes/index.ts`)

```typescript
app.register(faceProfileRoutes, { prefix: '/api/v1/face-profiles' })
app.register(recognitionEventRoutes, { prefix: '/api/v1/recognition-events' })
app.register(internalRecognitionEventRoutes) // path: /internal/recognition-events
```

### Redis Keys

| Key Pattern | TTL | Purpose |
|-------------|-----|---------|
| `alert:{orgId}:{cameraId}:{unknownFaceId}` | 300s | Debounce alerts |
| `face-profiles:list:{orgId}:{page}:{limit}` | 120s | Cache face profile list |

### Fastify Type Declarations

Add to `src/types/fastify.d.ts`:
- `rekognition: RekognitionClient`
- `s3: S3Client`

---

## 8. Testing Strategy

### Unit Tests

| Test File | Coverage |
|-----------|----------|
| `tests/face-profiles/face-profiles.test.ts` | CRUD, validation (bad type, too large, no face, multiple faces), org scoping |
| `tests/face-profiles/face-profile-permissions.test.ts` | Viewers create/view, admins delete, cross-org isolation |
| `tests/recognition-events/recognition-events.test.ts` | List with all filters, cursor pagination, org scoping |
| `tests/internal/recognition-events.test.ts` | Valid payload, unknown dedup, alert trigger, invalid secret rejected |
| `tests/services/rekognition.service.test.ts` | Service methods with mocked AWS SDK |
| `tests/services/s3.service.test.ts` | Upload, signed URL, deletion |

### Integration / Isolation Tests

| Test File | Coverage |
|-----------|----------|
| `tests/face-profiles/cross-org-isolation.test.ts` | Org A cannot see/delete Org B's face profiles |
| `tests/recognition-events/cross-org-isolation.test.ts` | Org A cannot see Org B's recognition events |

### AWS Mocking Strategy

In test env (`NODE_ENV === 'test'`):
- Rekognition service returns mock FaceIds and confidence scores
- S3 service returns mock keys and signed URLs
- SES service logs emails rather than sending

### Lambda Tests

`lambda/face-recognition/__tests__/handler.test.ts` — Unit tests with mocked KVS, Rekognition, HTTP. Verify correct payload construction for known and unknown face scenarios.

---

## 9. Permissions Summary

| Action | Viewer | Org Admin |
|--------|--------|-----------|
| Create face profile | Yes | Yes |
| View face profiles | Yes | Yes |
| Delete face profile | No | Yes |
| View recognition events | Yes | Yes |

---

## 10. Key Design Decisions

1. **Multipart upload to API** — Keeps validation + Rekognition indexing atomic (no orphaned S3 objects)
2. **Pipeline separation** — Lambda stays thin (frame extraction + search), API owns business logic
3. **Unknown face dedup via temp collection** — Indexes unknowns in `unknown-{orgId}`, searches before alerting to identify recurring individuals
4. **24-hour unknown retention** — Balances dedup accuracy with collection size management
5. **80% confidence threshold** — Industry-standard Rekognition default
6. **5-minute alert debounce** — Per camera per unknown individual, prevents inbox flooding
7. **Lazy collection creation** — Collections created on first use, not on org creation
8. **Single Lambda, dual purpose** — Recognition + purge, distinguished by event shape
