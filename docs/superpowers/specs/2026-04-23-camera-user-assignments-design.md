# Camera-to-User Assignment Design

**Goal:** Allow org admins to assign specific cameras to viewers so they only see cameras explicitly granted to them.

**Model:** Whitelist — viewers see nothing until cameras are assigned. Org admins always see all cameras (assignments don't apply to them).

---

## Database Schema

New table `camera_assignments`:

```sql
CREATE TABLE camera_assignments (
  camera_id   UUID NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by UUID NOT NULL REFERENCES users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (camera_id, user_id)
);

CREATE INDEX idx_camera_assignments_user ON camera_assignments(user_id);
CREATE INDEX idx_camera_assignments_camera ON camera_assignments(camera_id);
```

- Composite PK `(camera_id, user_id)` prevents duplicate assignments
- `ON DELETE CASCADE` on both FKs — deleting a camera or user cleans up assignments
- `assigned_by` tracks who made the assignment (audit trail)
- No `org_id` column — org scoping enforced through the camera and user records

---

## API Endpoints

### Camera-Centric (manage viewers for a camera)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/cameras/:cameraId/viewers` | org_admin | List viewers assigned to a camera |
| POST | `/api/v1/cameras/:cameraId/viewers` | org_admin | Add viewers to a camera |
| PUT | `/api/v1/cameras/:cameraId/viewers` | org_admin | Replace all viewers for a camera |
| DELETE | `/api/v1/cameras/:cameraId/viewers` | org_admin | Remove specific viewers from a camera |

### User-Centric (manage cameras for a viewer)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/org/users/:userId/cameras` | org_admin | List cameras assigned to a viewer |
| POST | `/api/v1/org/users/:userId/cameras` | org_admin | Add cameras to a viewer |
| PUT | `/api/v1/org/users/:userId/cameras` | org_admin | Replace all cameras for a viewer |
| DELETE | `/api/v1/org/users/:userId/cameras` | org_admin | Remove specific cameras from a viewer |

### Request/Response Shapes

**POST (add):**
```jsonc
// POST /api/v1/cameras/:cameraId/viewers
{ "user_ids": ["uuid1", "uuid2"] }
// 200
{ "assigned": 2 }
```

**PUT (replace all):**
```jsonc
// PUT /api/v1/cameras/:cameraId/viewers
{ "user_ids": ["uuid1", "uuid2"] }
// 200
{ "assigned": 2 }
```

**DELETE (remove):**
```jsonc
// DELETE /api/v1/cameras/:cameraId/viewers
{ "user_ids": ["uuid1"] }
// 200
{ "removed": 1 }
```

**GET (list viewers for camera):**
```jsonc
// GET /api/v1/cameras/:cameraId/viewers
// 200
{
  "viewers": [
    { "id": "uuid", "email": "viewer@example.com", "name": "Jane Doe", "assigned_at": "2026-04-23T12:00:00Z" }
  ]
}
```

**GET (list cameras for user):**
```jsonc
// GET /api/v1/org/users/:userId/cameras
// 200
{
  "cameras": [
    { "id": "uuid", "name": "Front Door", "slug": "front-door", "status": "active", "assigned_at": "2026-04-23T12:00:00Z" }
  ]
}
```

User-centric endpoints mirror these shapes with `camera_ids` instead of `user_ids`:

```jsonc
// POST /api/v1/org/users/:userId/cameras
{ "camera_ids": ["uuid1", "uuid2"] }
// 200
{ "assigned": 2 }

// PUT /api/v1/org/users/:userId/cameras
{ "camera_ids": ["uuid1", "uuid2"] }
// 200
{ "assigned": 2 }

// DELETE /api/v1/org/users/:userId/cameras
{ "camera_ids": ["uuid1"] }
// 200
{ "removed": 1 }
```

### Inline Assignment on Camera Creation

`POST /api/v1/cameras` accepts an optional `viewer_ids` field:

```jsonc
{ "name": "Front Door", "slug": "front-door", "viewer_ids": ["uuid1", "uuid2"] }
```

Assignments are created in the same transaction as the camera.

---

## Modified Existing Endpoints

Viewer access is now gated by assignment on all camera-specific endpoints:

| Endpoint | org_admin | viewer |
|----------|-----------|--------|
| `GET /api/v1/cameras` (list) | All org cameras | Only assigned cameras |
| `GET /api/v1/cameras/:id` (detail) | Any org camera | 403 if not assigned |
| `GET /api/v1/cameras/:id/credentials` | Any org camera | 403 if not assigned |

### List Cameras Query

**org_admin** (unchanged):
```sql
SELECT * FROM cameras WHERE org_id = $1 AND status = 'active'
ORDER BY created_at DESC LIMIT $2 OFFSET $3
```

**viewer** (filtered by assignments):
```sql
SELECT c.* FROM cameras c
INNER JOIN camera_assignments ca ON ca.camera_id = c.id
WHERE c.org_id = $1 AND c.status = 'active' AND ca.user_id = $2
ORDER BY c.created_at DESC LIMIT $3 OFFSET $4
```

Inactive cameras are filtered at query level. Assignments are preserved — if a camera is reactivated, assigned viewers see it again automatically.

### Single Camera / Credentials Access

For `GET /api/v1/cameras/:id` and `GET /api/v1/cameras/:id/credentials`:

If `req.user.role === 'viewer'`, check for a row in `camera_assignments` where `camera_id = :id AND user_id = req.user.id`. Return **403** (`CAMERA_NOT_ASSIGNED`) if no row exists.

---

## Cache Strategy

Current key: `cameras:list:{orgId}:{page}:{limit}`

Updated:
- **org_admin**: `cameras:list:{orgId}:{page}:{limit}` (unchanged)
- **viewer**: `cameras:list:{orgId}:{userId}:{page}:{limit}`

**Invalidation triggers:**
- Camera mutations (create, update, delete, status change): invalidate `cameras:list:{orgId}:*`
- Assignment mutations (POST/PUT/DELETE viewers or cameras): invalidate `cameras:list:{orgId}:*`

Same wildcard deletion pattern already used for camera mutations.

---

## Validation & Error Handling

### Input Validation

- `user_ids` / `camera_ids`: non-empty array, max 100 items, each valid UUID (Zod schema)
- `viewer_ids` on camera creation: same rules, optional field
- Referenced users must exist, belong to same org, and have role `viewer`
- Referenced cameras must exist and belong to same org

### Error Responses

| Scenario | Status | Code |
|----------|--------|------|
| User not found, wrong org, or not a viewer | 400 | `INVALID_USER_IDS` |
| Camera not found or wrong org | 404 | `CAMERA_NOT_FOUND` |
| Viewer accessing unassigned camera | 403 | `CAMERA_NOT_ASSIGNED` |

Assigning to an org_admin returns 400: `"Cannot assign cameras to org admins — they already have access to all cameras"`

### Idempotency

- **POST** (add): `INSERT ... ON CONFLICT DO NOTHING` — adding already-assigned items is a no-op
- **PUT** (replace): delete all existing assignments, insert new ones — clean slate
- **DELETE** (remove): removes only specified pairs, no error if pair doesn't exist

---

## Security

- All 8 new endpoints require `org_admin` role via `requireOrgAdmin` middleware
- Cross-org isolation: all queries verify camera and user belong to `req.user.org_id`
- Viewer access checks on existing endpoints use the same org-scoped queries
- No new attack surface — assignments are a server-side concept, viewers cannot self-assign
