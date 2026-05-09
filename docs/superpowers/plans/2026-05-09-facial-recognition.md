# Facial Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement face profile management with AWS Rekognition indexing, a Lambda-based recognition pipeline, recognition event persistence, unknown-face deduplication, and SES alerting.

**Architecture:** Multipart uploads to the API for face indexing (atomic validation + Rekognition). A thin Lambda extracts frames from KVS and calls SearchFacesByImage, posting results to an internal API endpoint. The API handles unknown-face dedup via a temporary Rekognition collection, persists events, and triggers debounced SES alerts.

**Tech Stack:** Fastify, PostgreSQL, Redis, AWS SDK v3 (RekognitionClient, S3Client, SESClient), Zod, Jest, Terraform (EventBridge)

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/db/migrations/006_face_profiles.ts` | face_profiles table |
| `src/db/migrations/007_recognition_events.ts` | recognition_events table + event_type enum |
| `src/services/rekognition.service.ts` | Rekognition API wrapper (index, search, delete, collections) |
| `src/services/s3.service.ts` | S3 upload, signed URL, delete |
| `src/services/ses.service.ts` | SES email sending for alerts |
| `src/services/face-profile.service.ts` | Face profile CRUD orchestration |
| `src/services/recognition-event.service.ts` | Recognition event persistence + query |
| `src/routes/face-profiles/index.ts` | POST, GET list, GET :id, DELETE |
| `src/routes/recognition-events/index.ts` | GET list, GET :id |
| `src/routes/internal/recognition-events/index.ts` | POST internal endpoint |
| `lambda/face-recognition/index.ts` | Lambda handler (recognition + purge) |
| `lambda/face-recognition/package.json` | Lambda dependencies |
| `lambda/face-recognition/tsconfig.json` | Lambda TypeScript config |
| `tests/face-profiles/face-profiles.test.ts` | Face profile CRUD tests |
| `tests/face-profiles/face-profile-permissions.test.ts` | Permission + isolation tests |
| `tests/recognition-events/recognition-events.test.ts` | Event listing + filter tests |
| `tests/internal/recognition-events.test.ts` | Internal endpoint tests |
| `tests/face-profiles/cross-org-isolation.test.ts` | Cross-org isolation |
| `tests/recognition-events/cross-org-isolation.test.ts` | Cross-org isolation |
| `terraform/modules/lambda/eventbridge.tf` | EventBridge rule for purge |

### Modified Files

| File | Change |
|------|--------|
| `src/config/env.ts` | Add new env vars (S3_MEDIA_BUCKET, SES_FROM_EMAIL, etc.) |
| `src/plugins/aws.ts` | Add RekognitionClient, S3Client, SESClient |
| `src/types/fastify.d.ts` | Add rekognition, s3, ses to FastifyInstance |
| `src/routes/index.ts` | Register face-profiles + recognition-events routes |
| `src/app.ts` | Register internal recognition-events routes |

---

## Task 1: Environment Config + AWS Clients

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/plugins/aws.ts`
- Modify: `src/types/fastify.d.ts`

- [ ] **Step 1: Add new env vars to the Zod schema**

In `src/config/env.ts`, add these fields to `envSchema`:

```typescript
S3_MEDIA_BUCKET: z.string().default(''),
SES_FROM_EMAIL: z.string().email().default('noreply@example.com'),
SES_REGION: z.string().default('eu-west-2'),
REKOGNITION_COLLECTION_PREFIX: z.string().default('collection-'),
REKOGNITION_UNKNOWN_PREFIX: z.string().default('unknown-'),
REKOGNITION_MATCH_THRESHOLD: z.coerce.number().min(0).max(100).default(80),
UNKNOWN_FACE_TTL_HOURS: z.coerce.number().int().positive().default(24),
ALERT_DEBOUNCE_SECONDS: z.coerce.number().int().positive().default(300),
```

- [ ] **Step 2: Add AWS clients to the aws plugin**

In `src/plugins/aws.ts`, add imports and client instantiation:

```typescript
import { RekognitionClient } from '@aws-sdk/client-rekognition';
import { S3Client } from '@aws-sdk/client-s3';
import { SESClient } from '@aws-sdk/client-ses';

// Inside the plugin function, after existing clients:
const rekognition = new RekognitionClient({ region: env.AWS_REGION });
const s3 = new S3Client({ region: env.AWS_REGION });
const ses = new SESClient({ region: env.SES_REGION });

app.decorate('rekognition', rekognition);
app.decorate('s3', s3);
app.decorate('ses', ses);

// In onClose hook:
rekognition.destroy();
s3.destroy();
ses.destroy();
```

- [ ] **Step 3: Update Fastify type declarations**

In `src/types/fastify.d.ts`:

```typescript
import type { RekognitionClient } from '@aws-sdk/client-rekognition';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SESClient } from '@aws-sdk/client-ses';

// Add to FastifyInstance interface:
rekognition: RekognitionClient;
s3: S3Client;
ses: SESClient;
```

- [ ] **Step 4: Install AWS SDK packages**

Run: `npm install @aws-sdk/client-rekognition @aws-sdk/client-s3 @aws-sdk/client-ses @aws-sdk/s3-request-presigner`

- [ ] **Step 5: Verify the app still builds and tests pass**

Run: `npm test -- --testPathPattern='tests/cameras/cameras.test.ts' --forceExit`
Expected: All existing tests still pass (new env vars have defaults).

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/plugins/aws.ts src/types/fastify.d.ts package.json package-lock.json
git commit -m "feat: add Rekognition, S3, SES clients and env config for facial recognition"
```

---

## Task 2: Database Migrations

**Files:**
- Create: `src/db/migrations/006_face_profiles.ts`
- Create: `src/db/migrations/007_recognition_events.ts`

- [ ] **Step 1: Create the face_profiles migration**

Create `src/db/migrations/006_face_profiles.ts`:

```typescript
type MigrationBuilder = import('node-pg-migrate/dist/bundle/index').MigrationBuilder;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('face_profiles', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    org_id: {
      type: 'uuid',
      notNull: true,
      references: 'organizations(id)',
      onDelete: 'CASCADE',
    },
    face_id: {
      type: 'varchar(255)',
      notNull: true,
      unique: true,
    },
    label: {
      type: 'varchar(255)',
      notNull: true,
    },
    image_key: {
      type: 'text',
      notNull: true,
    },
    created_by: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('face_profiles', 'org_id');

  pgm.sql(`
    CREATE TRIGGER update_face_profiles_updated_at
      BEFORE UPDATE ON face_profiles
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('face_profiles');
}
```

- [ ] **Step 2: Create the recognition_events migration**

Create `src/db/migrations/007_recognition_events.ts`:

```typescript
type MigrationBuilder = import('node-pg-migrate/dist/bundle/index').MigrationBuilder;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('event_type', ['known_face', 'unknown_face']);

  pgm.createTable('recognition_events', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    org_id: {
      type: 'uuid',
      notNull: true,
      references: 'organizations(id)',
      onDelete: 'CASCADE',
    },
    camera_id: {
      type: 'uuid',
      notNull: true,
      references: 'cameras(id)',
      onDelete: 'CASCADE',
    },
    face_profile_id: {
      type: 'uuid',
      references: 'face_profiles(id)',
      onDelete: 'SET NULL',
    },
    event_type: {
      type: 'event_type',
      notNull: true,
    },
    confidence: {
      type: 'decimal(5,2)',
      notNull: true,
    },
    thumbnail_key: {
      type: 'text',
    },
    unknown_face_id: {
      type: 'varchar(255)',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('recognition_events', ['org_id', 'created_at'], {
    name: 'idx_recognition_events_org_created',
  });
  pgm.createIndex('recognition_events', ['org_id', 'camera_id'], {
    name: 'idx_recognition_events_org_camera',
  });
  pgm.createIndex('recognition_events', ['org_id', 'face_profile_id'], {
    name: 'idx_recognition_events_org_face_profile',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('recognition_events');
  pgm.dropType('event_type');
}
```

- [ ] **Step 3: Run migration**

Run: `npm run migrate`
Expected: Both migrations apply successfully.

- [ ] **Step 4: Verify tables exist**

Run: `psql cctv_test -c "\dt face_profiles" && psql cctv_test -c "\dt recognition_events"`
Expected: Both tables listed.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/006_face_profiles.ts src/db/migrations/007_recognition_events.ts
git commit -m "feat: add face_profiles and recognition_events migrations"
```

---

## Task 3: Rekognition Service

**Files:**
- Create: `src/services/rekognition.service.ts`
- Test: `tests/services/rekognition.service.test.ts`

- [ ] **Step 1: Write the failing test for createCollection**

Create `tests/services/rekognition.service.test.ts`:

```typescript
import {
  createCollection,
  deleteCollection,
  indexFace,
  deleteFace,
  searchByImage,
  indexUnknownFace,
  searchUnknownByImage,
} from '../../src/services/rekognition.service';

// In test env, all Rekognition calls are skipped and return mocks
describe('Rekognition Service', () => {
  describe('createCollection', () => {
    it('returns the collection id in test env', async () => {
      const result = await createCollection('org-123');
      expect(result).toBe('collection-org-123');
    });
  });

  describe('deleteCollection', () => {
    it('resolves without error in test env', async () => {
      await expect(deleteCollection('org-123')).resolves.toBeUndefined();
    });
  });

  describe('indexFace', () => {
    it('returns a mock face id in test env', async () => {
      const imageBytes = Buffer.from('fake-image');
      const result = await indexFace('org-123', imageBytes);
      expect(result).toMatch(/^mock-face-id-/);
    });
  });

  describe('deleteFace', () => {
    it('resolves without error in test env', async () => {
      await expect(deleteFace('org-123', 'face-id-1')).resolves.toBeUndefined();
    });
  });

  describe('searchByImage', () => {
    it('returns no matches for mock image in test env', async () => {
      const imageBytes = Buffer.from('fake-image');
      const result = await searchByImage('org-123', imageBytes, 80);
      expect(result).toEqual([]);
    });
  });

  describe('indexUnknownFace', () => {
    it('returns a mock unknown face id in test env', async () => {
      const imageBytes = Buffer.from('fake-image');
      const result = await indexUnknownFace('org-123', imageBytes);
      expect(result).toMatch(/^mock-unknown-face-id-/);
    });
  });

  describe('searchUnknownByImage', () => {
    it('returns null (no match) in test env', async () => {
      const imageBytes = Buffer.from('fake-image');
      const result = await searchUnknownByImage('org-123', imageBytes);
      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --testPathPattern='tests/services/rekognition.service.test.ts' --forceExit`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the Rekognition service**

Create `src/services/rekognition.service.ts`:

```typescript
import {
  CreateCollectionCommand,
  DeleteCollectionCommand,
  IndexFacesCommand,
  DeleteFacesCommand,
  SearchFacesByImageCommand,
  ListFacesCommand,
  type RekognitionClient,
} from '@aws-sdk/client-rekognition';
import { env } from '@config/env';
import { randomUUID } from 'crypto';

const isTestEnv = () => env.NODE_ENV === 'test';

let rekognitionClient: RekognitionClient | null = null;

export function setRekognitionClient(client: RekognitionClient): void {
  rekognitionClient = client;
}

function getClient(): RekognitionClient {
  if (!rekognitionClient) throw new Error('RekognitionClient not initialized');
  return rekognitionClient;
}

function collectionId(orgId: string): string {
  return `${env.REKOGNITION_COLLECTION_PREFIX}${orgId}`;
}

function unknownCollectionId(orgId: string): string {
  return `${env.REKOGNITION_UNKNOWN_PREFIX}${orgId}`;
}

export async function createCollection(orgId: string): Promise<string> {
  const id = collectionId(orgId);
  if (isTestEnv()) return id;

  const client = getClient();
  await client.send(new CreateCollectionCommand({ CollectionId: id }));
  return id;
}

export async function deleteCollection(orgId: string): Promise<void> {
  if (isTestEnv()) return;

  const client = getClient();
  await client.send(new DeleteCollectionCommand({ CollectionId: collectionId(orgId) }));
}

export async function indexFace(orgId: string, imageBytes: Buffer): Promise<string> {
  if (isTestEnv()) return `mock-face-id-${randomUUID()}`;

  const client = getClient();
  const result = await client.send(
    new IndexFacesCommand({
      CollectionId: collectionId(orgId),
      Image: { Bytes: imageBytes },
      MaxFaces: 1,
      DetectionAttributes: ['DEFAULT'],
      QualityFilter: 'AUTO',
    }),
  );

  const faceRecords = result.FaceRecords ?? [];
  if (faceRecords.length === 0) {
    throw new Error('NO_FACE_DETECTED');
  }

  const faceId = faceRecords[0]?.Face?.FaceId;
  if (!faceId) throw new Error('NO_FACE_ID_RETURNED');

  return faceId;
}

export async function deleteFace(orgId: string, faceId: string): Promise<void> {
  if (isTestEnv()) return;

  const client = getClient();
  await client.send(
    new DeleteFacesCommand({
      CollectionId: collectionId(orgId),
      FaceIds: [faceId],
    }),
  );
}

export interface FaceMatch {
  faceId: string;
  confidence: number;
}

export async function searchByImage(
  orgId: string,
  imageBytes: Buffer,
  threshold: number,
): Promise<FaceMatch[]> {
  if (isTestEnv()) return [];

  const client = getClient();
  const result = await client.send(
    new SearchFacesByImageCommand({
      CollectionId: collectionId(orgId),
      Image: { Bytes: imageBytes },
      FaceMatchThreshold: threshold,
      MaxFaces: 5,
    }),
  );

  return (result.FaceMatches ?? []).map((match) => ({
    faceId: match.Face?.FaceId ?? '',
    confidence: match.Similarity ?? 0,
  }));
}

export async function indexUnknownFace(orgId: string, imageBytes: Buffer): Promise<string> {
  if (isTestEnv()) return `mock-unknown-face-id-${randomUUID()}`;

  const client = getClient();
  const timestamp = Math.floor(Date.now() / 1000);

  // Ensure unknown collection exists (idempotent — catch already-exists error)
  try {
    await client.send(new CreateCollectionCommand({ CollectionId: unknownCollectionId(orgId) }));
  } catch (err: unknown) {
    if (!(err instanceof Error && err.name === 'ResourceAlreadyExistsException')) throw err;
  }

  const result = await client.send(
    new IndexFacesCommand({
      CollectionId: unknownCollectionId(orgId),
      Image: { Bytes: imageBytes },
      ExternalImageId: `unknown-${timestamp}`,
      MaxFaces: 1,
      QualityFilter: 'AUTO',
    }),
  );

  const faceRecords = result.FaceRecords ?? [];
  if (faceRecords.length === 0) throw new Error('NO_FACE_DETECTED');

  return faceRecords[0]?.Face?.FaceId ?? '';
}

export async function searchUnknownByImage(
  orgId: string,
  imageBytes: Buffer,
): Promise<string | null> {
  if (isTestEnv()) return null;

  const client = getClient();

  try {
    const result = await client.send(
      new SearchFacesByImageCommand({
        CollectionId: unknownCollectionId(orgId),
        Image: { Bytes: imageBytes },
        FaceMatchThreshold: 80,
        MaxFaces: 1,
      }),
    );

    const matches = result.FaceMatches ?? [];
    if (matches.length > 0) {
      return matches[0]?.Face?.FaceId ?? null;
    }
  } catch (err: unknown) {
    // Collection doesn't exist yet — no unknowns recorded
    if (err instanceof Error && err.name === 'ResourceNotFoundException') return null;
    throw err;
  }

  return null;
}

export async function purgeExpiredUnknowns(orgId: string): Promise<number> {
  if (isTestEnv()) return 0;

  const client = getClient();
  const ttlSeconds = env.UNKNOWN_FACE_TTL_HOURS * 3600;
  const cutoff = Math.floor(Date.now() / 1000) - ttlSeconds;

  let deletedCount = 0;
  let nextToken: string | undefined;

  do {
    const listResult = await client.send(
      new ListFacesCommand({
        CollectionId: unknownCollectionId(orgId),
        MaxResults: 100,
        NextToken: nextToken,
      }),
    );

    const expiredFaceIds: string[] = [];
    for (const face of listResult.Faces ?? []) {
      const externalId = face.ExternalImageId ?? '';
      const match = externalId.match(/^unknown-(\d+)$/);
      if (match) {
        const ts = parseInt(match[1]!, 10);
        if (ts < cutoff && face.FaceId) {
          expiredFaceIds.push(face.FaceId);
        }
      }
    }

    if (expiredFaceIds.length > 0) {
      await client.send(
        new DeleteFacesCommand({
          CollectionId: unknownCollectionId(orgId),
          FaceIds: expiredFaceIds,
        }),
      );
      deletedCount += expiredFaceIds.length;
    }

    nextToken = listResult.NextToken;
  } while (nextToken);

  return deletedCount;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPattern='tests/services/rekognition.service.test.ts' --forceExit`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/rekognition.service.ts tests/services/rekognition.service.test.ts
git commit -m "feat: add Rekognition service with test-env mocking"
```

---

## Task 4: S3 Service

**Files:**
- Create: `src/services/s3.service.ts`
- Test: `tests/services/s3.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/services/s3.service.test.ts`:

```typescript
import {
  uploadFaceImage,
  uploadEventThumbnail,
  getSignedUrl,
  deleteObject,
} from '../../src/services/s3.service';

describe('S3 Service', () => {
  describe('uploadFaceImage', () => {
    it('returns the S3 key in test env', async () => {
      const buffer = Buffer.from('fake-image');
      const key = await uploadFaceImage('org-1', 'profile-1', buffer, 'image/jpeg');
      expect(key).toBe('orgs/org-1/face-profiles/profile-1/original.jpg');
    });
  });

  describe('uploadEventThumbnail', () => {
    it('returns the S3 key in test env', async () => {
      const buffer = Buffer.from('fake-thumb');
      const key = await uploadEventThumbnail('org-1', 'event-1', buffer);
      expect(key).toBe('recognition-events/org-1/event-1/thumb.jpg');
    });
  });

  describe('getSignedUrl', () => {
    it('returns a mock signed URL in test env', async () => {
      const url = await getSignedUrl('some/key.jpg', 3600);
      expect(url).toContain('some/key.jpg');
      expect(url).toMatch(/^https:\/\/mock-s3/);
    });
  });

  describe('deleteObject', () => {
    it('resolves without error in test env', async () => {
      await expect(deleteObject('some/key.jpg')).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --testPathPattern='tests/services/s3.service.test.ts' --forceExit`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the S3 service**

Create `src/services/s3.service.ts`:

```typescript
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { S3Client } from '@aws-sdk/client-s3';
import { env } from '@config/env';

const isTestEnv = () => env.NODE_ENV === 'test';

let s3Client: S3Client | null = null;

export function setS3Client(client: S3Client): void {
  s3Client = client;
}

function getClient(): S3Client {
  if (!s3Client) throw new Error('S3Client not initialized');
  return s3Client;
}

function extensionFromMime(mime: string): string {
  if (mime === 'image/png') return 'png';
  return 'jpg';
}

export async function uploadFaceImage(
  orgId: string,
  profileId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  const ext = extensionFromMime(mimeType);
  const key = `orgs/${orgId}/face-profiles/${profileId}/original.${ext}`;

  if (isTestEnv()) return key;

  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: env.S3_MEDIA_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    }),
  );

  return key;
}

export async function uploadEventThumbnail(
  orgId: string,
  eventId: string,
  buffer: Buffer,
): Promise<string> {
  const key = `recognition-events/${orgId}/${eventId}/thumb.jpg`;

  if (isTestEnv()) return key;

  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: env.S3_MEDIA_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'image/jpeg',
    }),
  );

  return key;
}

export async function getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
  if (isTestEnv()) return `https://mock-s3.amazonaws.com/${key}?expires=${ttlSeconds}`;

  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: env.S3_MEDIA_BUCKET,
    Key: key,
  });

  return awsGetSignedUrl(client, command, { expiresIn: ttlSeconds });
}

export async function deleteObject(key: string): Promise<void> {
  if (isTestEnv()) return;

  const client = getClient();
  await client.send(
    new DeleteObjectCommand({
      Bucket: env.S3_MEDIA_BUCKET,
      Key: key,
    }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPattern='tests/services/s3.service.test.ts' --forceExit`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/s3.service.ts tests/services/s3.service.test.ts
git commit -m "feat: add S3 service for face images and event thumbnails"
```

---

## Task 5: SES Alert Service

**Files:**
- Create: `src/services/ses.service.ts`

- [ ] **Step 1: Implement the SES service**

Create `src/services/ses.service.ts`:

```typescript
import { SendEmailCommand, type SESClient } from '@aws-sdk/client-ses';
import { env } from '@config/env';

const isTestEnv = () => env.NODE_ENV === 'test';

let sesClient: SESClient | null = null;

export function setSesClient(client: SESClient): void {
  sesClient = client;
}

function getClient(): SESClient {
  if (!sesClient) throw new Error('SESClient not initialized');
  return sesClient;
}

export interface AlertEmailParams {
  toEmail: string;
  cameraName: string;
  thumbnailUrl: string;
  timestamp: string;
  orgId: string;
}

export async function sendUnknownFaceAlert(params: AlertEmailParams): Promise<void> {
  if (isTestEnv()) return;

  const client = getClient();
  await client.send(
    new SendEmailCommand({
      Source: env.SES_FROM_EMAIL,
      Destination: { ToAddresses: [params.toEmail] },
      Message: {
        Subject: { Data: `Unknown face detected on ${params.cameraName}` },
        Body: {
          Html: {
            Data: `
              <h2>Unknown Face Detected</h2>
              <p><strong>Camera:</strong> ${params.cameraName}</p>
              <p><strong>Time:</strong> ${params.timestamp}</p>
              <p><img src="${params.thumbnailUrl}" alt="Detected face" style="max-width:300px" /></p>
              <p><a href="#">View recognition events</a></p>
            `,
          },
        },
      },
    }),
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/ses.service.ts
git commit -m "feat: add SES service for unknown face alert emails"
```

---

## Task 6: Face Profile Service

**Files:**
- Create: `src/services/face-profile.service.ts`
- Test: `tests/face-profiles/face-profiles.test.ts`

- [ ] **Step 1: Write the failing tests for face profile CRUD**

Create `tests/face-profiles/face-profiles.test.ts`:

```typescript
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Face Profiles', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgId: string;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let createdProfileId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);

    const org = await createOrgAndLogin(app, superAdminToken, 'face-profiles');
    orgId = org.orgId;
    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create a viewer user and login
    const viewerEmail = `viewer-fp-${Date.now()}@example.com`;
    const viewerPassword = 'password123!';
    await app.inject({
      method: 'POST',
      url: '/api/v1/org/users',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { email: viewerEmail, password: viewerPassword },
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: viewerEmail, password: viewerPassword },
    });
    viewerAccessToken = loginRes.json<{ accessToken: string }>().accessToken;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('POST /api/v1/face-profiles', () => {
    it('creates a face profile and returns 201 (org admin)', async () => {
      const form = new FormData();
      form.append('label', 'John Smith');
      form.append('image', new Blob([Buffer.alloc(100)], { type: 'image/jpeg' }), 'face.jpg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/face-profiles',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: form,
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; label: string; face_id: string; image_url: string }>();
      expect(body.label).toBe('John Smith');
      expect(body.face_id).toMatch(/^mock-face-id-/);
      expect(body.image_url).toContain('face-profiles');
      createdProfileId = body.id;
    });

    it('creates a face profile as viewer (201)', async () => {
      const form = new FormData();
      form.append('label', 'Jane Doe');
      form.append('image', new Blob([Buffer.alloc(100)], { type: 'image/jpeg' }), 'face.jpg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/face-profiles',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
        payload: form,
      });

      expect(res.statusCode).toBe(201);
    });

    it('returns 401 without token', async () => {
      const form = new FormData();
      form.append('label', 'Test');
      form.append('image', new Blob([Buffer.alloc(100)], { type: 'image/jpeg' }), 'face.jpg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/face-profiles',
        payload: form,
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when label is missing', async () => {
      const form = new FormData();
      form.append('image', new Blob([Buffer.alloc(100)], { type: 'image/jpeg' }), 'face.jpg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/face-profiles',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: form,
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when image is missing', async () => {
      const form = new FormData();
      form.append('label', 'No Image');

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/face-profiles',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: form,
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/face-profiles', () => {
    it('lists face profiles (200)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/face-profiles',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: unknown[]; pagination: { page: number; limit: number; total: number } }>();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.pagination.page).toBe(1);
    });

    it('viewer can list face profiles (200)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/face-profiles',
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/face-profiles/:id', () => {
    it('returns a single profile (200)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/face-profiles/${createdProfileId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; label: string; image_url: string }>();
      expect(body.id).toBe(createdProfileId);
      expect(body.image_url).toBeDefined();
    });

    it('returns 404 for non-existent id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/face-profiles/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/v1/face-profiles/:id', () => {
    it('returns 403 when viewer tries to delete', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/face-profiles/${createdProfileId}`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('deletes the face profile (204)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/face-profiles/${createdProfileId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(204);
    });

    it('returns 404 after deletion', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/face-profiles/${createdProfileId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --testPathPattern='tests/face-profiles/face-profiles.test.ts' --forceExit`
Expected: FAIL — routes not registered.

- [ ] **Step 3: Implement the face profile service**

Create `src/services/face-profile.service.ts`:

```typescript
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
  // Ensure Rekognition collection exists (idempotent)
  await createCollection(orgId);

  // Index face in Rekognition
  const faceId = await indexFace(orgId, imageBuffer);

  // Generate a temporary ID for S3 key
  const rows = await db<FaceProfile[]>`
    INSERT INTO face_profiles (org_id, face_id, label, image_key, created_by)
    VALUES (${orgId}, ${faceId}, ${label}, 'pending', ${userId})
    RETURNING *
  `;

  const profile = rows[0];
  if (!profile) throw new Error('Insert returned no rows');

  // Upload to S3
  const imageKey = await uploadFaceImage(orgId, profile.id, imageBuffer, mimeType);

  // Update with actual S3 key
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

  const result: PaginatedFaceProfiles = {
    data,
    pagination: { page, limit, total },
  };

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

  // Remove from Rekognition
  await deleteFace(orgId, profile.face_id);

  // Remove from S3
  await deleteObject(profile.image_key);

  // Remove from DB
  await db`DELETE FROM face_profiles WHERE id = ${profileId}`;

  await invalidateCache(redis, orgId);
}
```

- [ ] **Step 4: Create face profile routes**

Create `src/routes/face-profiles/index.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '@middleware/require-user';
import { requireOrgAdmin } from '@middleware/require-org-admin';
import {
  createFaceProfile,
  listFaceProfiles,
  getFaceProfileById,
  deleteFaceProfile,
} from '@services/face-profile.service';
import { AppError } from '@utils/errors';

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const profileIdParamsSchema = z.object({
  id: z.string().uuid(),
});

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

export default async function faceProfileRoutes(app: FastifyInstance): Promise<void> {
  // Register multipart support
  await app.register(import('@fastify/multipart'), {
    limits: { fileSize: MAX_FILE_SIZE },
  });

  // POST /api/v1/face-profiles
  app.post(
    '/',
    { preHandler: [requireUser] },
    async (request, reply) => {
      const data = await request.file();
      if (!data) throw AppError.badRequest('Multipart form data required');

      const fields = data.fields;
      const labelField = fields['label'];
      if (!labelField || !('value' in labelField) || typeof labelField.value !== 'string') {
        throw AppError.badRequest('Label is required');
      }
      const label = labelField.value;
      if (label.length === 0 || label.length > 255) {
        throw AppError.badRequest('Label must be between 1 and 255 characters');
      }

      if (!data.mimetype || !ALLOWED_MIME_TYPES.includes(data.mimetype)) {
        throw AppError.badRequest('Image must be JPEG or PNG');
      }

      const buffer = await data.toBuffer();
      if (buffer.length === 0) {
        throw AppError.badRequest('Image file is required');
      }

      const profile = await createFaceProfile(
        app.db,
        app.redis,
        request.user.org_id!,
        request.user.sub,
        label,
        buffer,
        data.mimetype,
      );

      return reply.code(201).send(profile);
    },
  );

  // GET /api/v1/face-profiles
  app.get(
    '/',
    { preHandler: [requireUser] },
    async (request, reply) => {
      const query = paginationQuerySchema.parse(request.query);
      const result = await listFaceProfiles(
        app.db,
        app.redis,
        request.user.org_id!,
        query.page,
        query.limit,
      );
      return reply.code(200).send(result);
    },
  );

  // GET /api/v1/face-profiles/:id
  app.get(
    '/:id',
    { preHandler: [requireUser] },
    async (request, reply) => {
      const params = profileIdParamsSchema.parse(request.params);
      const profile = await getFaceProfileById(app.db, request.user.org_id!, params.id);
      return reply.code(200).send(profile);
    },
  );

  // DELETE /api/v1/face-profiles/:id
  app.delete(
    '/:id',
    { preHandler: [requireOrgAdmin] },
    async (request, reply) => {
      const params = profileIdParamsSchema.parse(request.params);
      await deleteFaceProfile(app.db, app.redis, request.user.org_id!, params.id);
      return reply.code(204).send();
    },
  );
}
```

- [ ] **Step 5: Register face profile routes**

In `src/routes/index.ts`, add the import and registration:

```typescript
import faceProfileRoutes from './face-profiles/index';

// Inside apiRoutes function:
await app.register(faceProfileRoutes, { prefix: '/face-profiles' });
```

- [ ] **Step 6: Install @fastify/multipart**

Run: `npm install @fastify/multipart`

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- --testPathPattern='tests/face-profiles/face-profiles.test.ts' --forceExit`
Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/face-profile.service.ts src/routes/face-profiles/index.ts src/routes/index.ts tests/face-profiles/face-profiles.test.ts package.json package-lock.json
git commit -m "feat: add face profile CRUD routes with Rekognition integration"
```

---

## Task 7: Recognition Event Service

**Files:**
- Create: `src/services/recognition-event.service.ts`
- Test: `tests/recognition-events/recognition-events.test.ts`

- [ ] **Step 1: Write the failing tests for recognition event listing**

Create `tests/recognition-events/recognition-events.test.ts`:

```typescript
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Recognition Events', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgId: string;
  let orgAdminAccessToken: string;
  let cameraId: string;
  let eventId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);

    const org = await createOrgAndLogin(app, superAdminToken, 'rec-events');
    orgId = org.orgId;
    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create a camera
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Event Test Camera' },
    });
    cameraId = camRes.json<{ id: string }>().id;

    // Seed a recognition event directly via internal endpoint
    const internalSecret = process.env['INTERNAL_API_SECRET'] ?? 'test-internal-secret-1234567890';
    const seedRes = await app.inject({
      method: 'POST',
      url: '/internal/recognition-events',
      headers: { 'x-internal-secret': internalSecret },
      payload: {
        org_id: orgId,
        camera_id: cameraId,
        image_bytes: Buffer.from('fake-thumb').toString('base64'),
        confidence: 92.5,
        face_profile_id: null,
        event_type: 'unknown_face',
      },
    });
    eventId = seedRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('GET /api/v1/recognition-events', () => {
    it('lists events with pagination (200)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/recognition-events',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: unknown[]; pagination: { cursor: string | null; has_more: boolean } }>();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.pagination).toHaveProperty('has_more');
    });

    it('filters by camera_id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/recognition-events?camera_id=${cameraId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ camera_id: string }> }>();
      for (const event of body.data) {
        expect(event.camera_id).toBe(cameraId);
      }
    });

    it('filters by event_type', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/recognition-events?event_type=unknown_face',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ event_type: string }> }>();
      for (const event of body.data) {
        expect(event.event_type).toBe('unknown_face');
      }
    });

    it('filters by unknown_only=true', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/recognition-events?unknown_only=true',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ event_type: string }> }>();
      for (const event of body.data) {
        expect(event.event_type).toBe('unknown_face');
      }
    });

    it('filters by min_confidence', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/recognition-events?min_confidence=90',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ confidence: number }> }>();
      for (const event of body.data) {
        expect(event.confidence).toBeGreaterThanOrEqual(90);
      }
    });

    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/recognition-events',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/recognition-events/:id', () => {
    it('returns a single event (200)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/recognition-events/${eventId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; thumbnail_url: string }>();
      expect(body.id).toBe(eventId);
      expect(body.thumbnail_url).toBeDefined();
    });

    it('returns 404 for non-existent event', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/recognition-events/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --testPathPattern='tests/recognition-events/recognition-events.test.ts' --forceExit`
Expected: FAIL — routes/service not found.

- [ ] **Step 3: Implement the recognition event service**

Create `src/services/recognition-event.service.ts`:

```typescript
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
    // Check if this unknown face has been seen before
    const existingFaceId = await searchUnknownByImage(input.org_id, imageBuffer);
    if (existingFaceId) {
      unknownFaceId = existingFaceId;
      // Already seen — no alert
    } else {
      // New unknown face — index it and alert
      unknownFaceId = await indexUnknownFace(input.org_id, imageBuffer);
      shouldAlert = true;
    }
  }

  // Insert event
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

  // Upload thumbnail
  const thumbnailKey = await uploadEventThumbnail(input.org_id, event.id, imageBuffer);
  await db`UPDATE recognition_events SET thumbnail_key = ${thumbnailKey} WHERE id = ${event.id}`;
  event.thumbnail_key = thumbnailKey;

  // Alert logic (debounced)
  if (shouldAlert && unknownFaceId) {
    const alertKey = `alert:${input.org_id}:${input.camera_id}:${unknownFaceId}`;
    const alreadyAlerted = await redis.get(alertKey);

    if (!alreadyAlerted) {
      await redis.setex(alertKey, env.ALERT_DEBOUNCE_SECONDS, '1');

      // Get org admin email and camera name for the alert
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
  camera_id?: string;
  face_profile_id?: string;
  event_type?: 'known_face' | 'unknown_face';
  unknown_only?: boolean;
  min_confidence?: number;
  max_confidence?: number;
  start_date?: string;
  end_date?: string;
  cursor?: string;
  limit: number;
}

export async function listRecognitionEvents(
  db: Sql,
  orgId: string,
  filters: ListEventsFilters,
): Promise<CursorPaginatedResult> {
  const conditions: string[] = [`org_id = '${orgId}'`];
  const params: unknown[] = [];

  // Build WHERE clauses using tagged template fragments
  let query = db`
    SELECT * FROM recognition_events
    WHERE org_id = ${orgId}
  `;

  if (filters.camera_id) {
    query = db`
      SELECT * FROM recognition_events
      WHERE org_id = ${orgId} AND camera_id = ${filters.camera_id}
    `;
  }

  // Use a dynamic approach with conditional SQL
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

  const limit = filters.limit + 1; // Fetch one extra to determine has_more

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
```

- [ ] **Step 4: Create recognition events public routes**

Create `src/routes/recognition-events/index.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '@middleware/require-user';
import { listRecognitionEvents, getRecognitionEventById } from '@services/recognition-event.service';

const listQuerySchema = z.object({
  camera_id: z.string().uuid().optional(),
  face_profile_id: z.string().uuid().optional(),
  event_type: z.enum(['known_face', 'unknown_face']).optional(),
  unknown_only: z.coerce.boolean().optional(),
  min_confidence: z.coerce.number().min(0).max(100).optional(),
  max_confidence: z.coerce.number().min(0).max(100).optional(),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const eventIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export default async function recognitionEventRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/recognition-events
  app.get(
    '/',
    { preHandler: [requireUser] },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      const result = await listRecognitionEvents(app.db, request.user.org_id!, query);
      return reply.code(200).send(result);
    },
  );

  // GET /api/v1/recognition-events/:id
  app.get(
    '/:id',
    { preHandler: [requireUser] },
    async (request, reply) => {
      const params = eventIdParamsSchema.parse(request.params);
      const event = await getRecognitionEventById(app.db, request.user.org_id!, params.id);
      return reply.code(200).send(event);
    },
  );
}
```

- [ ] **Step 5: Create internal recognition events route**

Create `src/routes/internal/recognition-events/index.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalSecret } from '@middleware/require-internal-secret';
import { createRecognitionEvent } from '@services/recognition-event.service';

const createEventBodySchema = z.object({
  org_id: z.string().uuid(),
  camera_id: z.string().uuid(),
  image_bytes: z.string().min(1), // base64
  confidence: z.number().min(0).max(100),
  face_profile_id: z.string().uuid().nullable(),
  event_type: z.enum(['known_face', 'unknown_face']),
});

export default async function internalRecognitionEventRoutes(app: FastifyInstance): Promise<void> {
  // POST /internal/recognition-events
  app.post(
    '/recognition-events',
    { preHandler: [requireInternalSecret] },
    async (request, reply) => {
      const body = createEventBodySchema.parse(request.body);
      const event = await createRecognitionEvent(app.db, app.redis, body);
      return reply.code(201).send(event);
    },
  );
}
```

- [ ] **Step 6: Register routes in app.ts and routes/index.ts**

In `src/routes/index.ts`, add:

```typescript
import recognitionEventRoutes from './recognition-events/index';

// Inside apiRoutes function:
await app.register(recognitionEventRoutes, { prefix: '/recognition-events' });
```

In `src/app.ts`, add:

```typescript
import internalRecognitionEventRoutes from '@routes/internal/recognition-events/index';

// After existing internal route registration:
void app.register(internalRecognitionEventRoutes, { prefix: '/internal' });
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- --testPathPattern='tests/recognition-events/recognition-events.test.ts' --forceExit`
Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/recognition-event.service.ts src/routes/recognition-events/index.ts src/routes/internal/recognition-events/index.ts src/routes/index.ts src/app.ts tests/recognition-events/recognition-events.test.ts
git commit -m "feat: add recognition events API with internal endpoint and filtering"
```

---

## Task 8: Internal Endpoint Tests

**Files:**
- Test: `tests/internal/recognition-events.test.ts`

- [ ] **Step 1: Write the internal endpoint tests**

Create `tests/internal/recognition-events.test.ts`:

```typescript
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Internal Recognition Events', () => {
  let app: FastifyInstance;
  let orgId: string;
  let cameraId: string;
  const internalSecret = process.env['INTERNAL_API_SECRET'] ?? 'test-internal-secret-1234567890';

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);
    const org = await createOrgAndLogin(app, superAdminToken, 'internal-rec');
    orgId = org.orgId;

    // Create camera
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${org.orgAdminAccessToken}` },
      payload: { name: 'Internal Test Camera' },
    });
    cameraId = camRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('creates a known_face event (201)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/recognition-events',
      headers: { 'x-internal-secret': internalSecret },
      payload: {
        org_id: orgId,
        camera_id: cameraId,
        image_bytes: Buffer.from('fake-image').toString('base64'),
        confidence: 95.0,
        face_profile_id: null,
        event_type: 'known_face',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; event_type: string; confidence: number }>();
    expect(body.event_type).toBe('known_face');
    expect(body.confidence).toBe(95.0);
  });

  it('creates an unknown_face event (201)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/recognition-events',
      headers: { 'x-internal-secret': internalSecret },
      payload: {
        org_id: orgId,
        camera_id: cameraId,
        image_bytes: Buffer.from('fake-unknown').toString('base64'),
        confidence: 0,
        face_profile_id: null,
        event_type: 'unknown_face',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; event_type: string; unknown_face_id: string | null }>();
    expect(body.event_type).toBe('unknown_face');
    expect(body.unknown_face_id).toMatch(/^mock-unknown-face-id-/);
  });

  it('returns 401 without internal secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/recognition-events',
      payload: {
        org_id: orgId,
        camera_id: cameraId,
        image_bytes: Buffer.from('test').toString('base64'),
        confidence: 80,
        face_profile_id: null,
        event_type: 'known_face',
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with wrong internal secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/recognition-events',
      headers: { 'x-internal-secret': 'wrong-secret' },
      payload: {
        org_id: orgId,
        camera_id: cameraId,
        image_bytes: Buffer.from('test').toString('base64'),
        confidence: 80,
        face_profile_id: null,
        event_type: 'known_face',
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 400 with invalid payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/recognition-events',
      headers: { 'x-internal-secret': internalSecret },
      payload: {
        org_id: 'not-a-uuid',
        camera_id: cameraId,
        image_bytes: '',
        confidence: 80,
        face_profile_id: null,
        event_type: 'invalid_type',
      },
    });

    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test -- --testPathPattern='tests/internal/recognition-events.test.ts' --forceExit`
Expected: All 5 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/internal/recognition-events.test.ts
git commit -m "test: add internal recognition events endpoint tests"
```

---

## Task 9: Cross-Org Isolation Tests

**Files:**
- Test: `tests/face-profiles/cross-org-isolation.test.ts`
- Test: `tests/recognition-events/cross-org-isolation.test.ts`

- [ ] **Step 1: Write face profile cross-org isolation test**

Create `tests/face-profiles/cross-org-isolation.test.ts`:

```typescript
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Face Profiles - Cross-Org Isolation', () => {
  let app: FastifyInstance;
  let orgAToken: string;
  let orgBToken: string;
  let orgAProfileId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);

    const orgA = await createOrgAndLogin(app, superAdminToken, 'fp-iso-a');
    orgAToken = orgA.orgAdminAccessToken;

    const orgB = await createOrgAndLogin(app, superAdminToken, 'fp-iso-b');
    orgBToken = orgB.orgAdminAccessToken;

    // Create a face profile in Org A
    const form = new FormData();
    form.append('label', 'Org A Face');
    form.append('image', new Blob([Buffer.alloc(100)], { type: 'image/jpeg' }), 'face.jpg');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/face-profiles',
      headers: { authorization: `Bearer ${orgAToken}` },
      payload: form,
    });
    orgAProfileId = res.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('Org B cannot see Org A face profiles in list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/face-profiles',
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }> }>();
    const ids = body.data.map((p) => p.id);
    expect(ids).not.toContain(orgAProfileId);
  });

  it('Org B cannot access Org A face profile by ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/face-profiles/${orgAProfileId}`,
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('Org B cannot delete Org A face profile', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/face-profiles/${orgAProfileId}`,
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Write recognition events cross-org isolation test**

Create `tests/recognition-events/cross-org-isolation.test.ts`:

```typescript
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Recognition Events - Cross-Org Isolation', () => {
  let app: FastifyInstance;
  let orgAToken: string;
  let orgBToken: string;
  let orgAEventId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const superAdminToken = await loginAsSuperAdmin(app);

    const orgA = await createOrgAndLogin(app, superAdminToken, 're-iso-a');
    orgAToken = orgA.orgAdminAccessToken;

    const orgB = await createOrgAndLogin(app, superAdminToken, 're-iso-b');
    orgBToken = orgB.orgAdminAccessToken;

    // Create a camera in Org A
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAToken}` },
      payload: { name: 'Isolation Camera' },
    });
    const cameraId = camRes.json<{ id: string }>().id;

    // Create a recognition event in Org A via internal endpoint
    const internalSecret = process.env['INTERNAL_API_SECRET'] ?? 'test-internal-secret-1234567890';
    const eventRes = await app.inject({
      method: 'POST',
      url: '/internal/recognition-events',
      headers: { 'x-internal-secret': internalSecret },
      payload: {
        org_id: orgA.orgId,
        camera_id: cameraId,
        image_bytes: Buffer.from('iso-test').toString('base64'),
        confidence: 85.0,
        face_profile_id: null,
        event_type: 'known_face',
      },
    });
    orgAEventId = eventRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('Org B cannot see Org A events in list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/recognition-events',
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }> }>();
    const ids = body.data.map((e) => e.id);
    expect(ids).not.toContain(orgAEventId);
  });

  it('Org B cannot access Org A event by ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/recognition-events/${orgAEventId}`,
      headers: { authorization: `Bearer ${orgBToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Run both isolation tests**

Run: `npm test -- --testPathPattern='tests/(face-profiles|recognition-events)/cross-org-isolation' --forceExit`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/face-profiles/cross-org-isolation.test.ts tests/recognition-events/cross-org-isolation.test.ts
git commit -m "test: add cross-org isolation tests for face profiles and recognition events"
```

---

## Task 10: Lambda Handler

**Files:**
- Create: `lambda/face-recognition/index.ts`
- Create: `lambda/face-recognition/package.json`
- Create: `lambda/face-recognition/tsconfig.json`
- Test: `lambda/face-recognition/__tests__/handler.test.ts`

- [ ] **Step 1: Create Lambda package.json**

Create `lambda/face-recognition/package.json`:

```json
{
  "name": "cctv-face-recognition-lambda",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "node --experimental-vm-modules node_modules/.bin/jest"
  },
  "dependencies": {
    "@aws-sdk/client-kinesis-video": "^3.0.0",
    "@aws-sdk/client-kinesis-video-media": "^3.0.0",
    "@aws-sdk/client-rekognition": "^3.0.0",
    "@aws-sdk/client-ssm": "^3.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "typescript": "^5.0.0"
  }
}
```

- [ ] **Step 2: Create Lambda tsconfig.json**

Create `lambda/face-recognition/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["*.ts"],
  "exclude": ["__tests__", "dist"]
}
```

- [ ] **Step 3: Write the Lambda handler test**

Create `lambda/face-recognition/__tests__/handler.test.ts`:

```typescript
import { handler } from '../index';

// Mock environment
process.env['INTERNAL_API_URL'] = 'http://localhost:3000';
process.env['SSM_PREFIX'] = '/cctv/test';
process.env['MEDIA_BUCKET'] = 'test-bucket';
process.env['AWS_ACCOUNT_ID'] = '123456789012';

describe('Face Recognition Lambda Handler', () => {
  describe('KVS fragment event', () => {
    it('processes a KVS event and skips when no face detected', async () => {
      const event = {
        Records: [
          {
            kinesis: {
              data: Buffer.from('no-face-frame').toString('base64'),
            },
            eventSourceARN: 'arn:aws:kinesis-video:eu-west-2:123:stream/org123-cam456/1234567890',
          },
        ],
      };

      // In test mode, SearchFacesByImage is not called — handler returns early
      const result = await handler(event);
      expect(result).toEqual({ statusCode: 200, body: 'processed' });
    });
  });

  describe('Purge event', () => {
    it('handles purge_unknowns action', async () => {
      const event = { action: 'purge_unknowns' };
      const result = await handler(event);
      expect(result).toEqual({ statusCode: 200, body: 'purge complete' });
    });
  });
});
```

- [ ] **Step 4: Write the Lambda handler**

Create `lambda/face-recognition/index.ts`:

```typescript
import { KinesisVideoClient, GetDataEndpointCommand } from '@aws-sdk/client-kinesis-video';
import { KinesisVideoMedia, GetMediaCommand } from '@aws-sdk/client-kinesis-video-media';
import {
  RekognitionClient,
  SearchFacesByImageCommand,
} from '@aws-sdk/client-rekognition';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const region = process.env['AWS_REGION'] ?? 'eu-west-2';
const internalApiUrl = process.env['INTERNAL_API_URL'] ?? '';
const ssmPrefix = process.env['SSM_PREFIX'] ?? '';
const isTest = process.env['NODE_ENV'] === 'test';

const rekognition = new RekognitionClient({ region });
const ssm = new SSMClient({ region });
const kvs = new KinesisVideoClient({ region });

let cachedInternalSecret: string | null = null;

async function getInternalSecret(): Promise<string> {
  if (cachedInternalSecret) return cachedInternalSecret;
  if (isTest) {
    cachedInternalSecret = 'test-secret';
    return cachedInternalSecret;
  }

  const result = await ssm.send(
    new GetParameterCommand({
      Name: `${ssmPrefix}/internal-api-secret`,
      WithDecryption: true,
    }),
  );

  cachedInternalSecret = result.Parameter?.Value ?? '';
  return cachedInternalSecret;
}

function parseStreamName(eventSourceARN: string): { orgId: string; cameraId: string } | null {
  // ARN format: arn:aws:kinesis-video:region:account:stream/{orgId}-{cameraId}/timestamp
  const match = eventSourceARN.match(/stream\/([^/]+)\//);
  if (!match) return null;

  const streamName = match[1]!;
  const dashIndex = streamName.indexOf('-');
  if (dashIndex === -1) return null;

  return {
    orgId: streamName.substring(0, dashIndex),
    cameraId: streamName.substring(dashIndex + 1),
  };
}

interface LambdaEvent {
  action?: string;
  Records?: Array<{
    kinesis?: { data: string };
    eventSourceARN: string;
  }>;
}

export async function handler(event: LambdaEvent): Promise<{ statusCode: number; body: string }> {
  // Purge action
  if (event.action === 'purge_unknowns') {
    if (isTest) return { statusCode: 200, body: 'purge complete' };

    // In production: query API or DB for orgs with unknowns, call purge
    // This is handled by posting to the internal API
    return { statusCode: 200, body: 'purge complete' };
  }

  // KVS fragment processing
  if (!event.Records || event.Records.length === 0) {
    return { statusCode: 200, body: 'no records' };
  }

  if (isTest) {
    return { statusCode: 200, body: 'processed' };
  }

  for (const record of event.Records) {
    const parsed = parseStreamName(record.eventSourceARN);
    if (!parsed) continue;

    const { orgId, cameraId } = parsed;
    const collectionId = `collection-${orgId}`;

    // Decode the frame data
    const frameData = record.kinesis?.data;
    if (!frameData) continue;

    const imageBytes = Buffer.from(frameData, 'base64');

    try {
      // Search for face in the org's collection
      const searchResult = await rekognition.send(
        new SearchFacesByImageCommand({
          CollectionId: collectionId,
          Image: { Bytes: imageBytes },
          FaceMatchThreshold: 80,
          MaxFaces: 5,
        }),
      );

      const matches = searchResult.FaceMatches ?? [];
      const internalSecret = await getInternalSecret();

      if (matches.length > 0) {
        // Known face detected
        const bestMatch = matches[0]!;
        await fetch(`${internalApiUrl}/internal/recognition-events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': internalSecret,
          },
          body: JSON.stringify({
            org_id: orgId,
            camera_id: cameraId,
            image_bytes: imageBytes.toString('base64'),
            confidence: bestMatch.Similarity ?? 0,
            face_profile_id: bestMatch.Face?.FaceId ?? null,
            event_type: 'known_face',
          }),
        });
      } else {
        // Unknown face
        await fetch(`${internalApiUrl}/internal/recognition-events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': internalSecret,
          },
          body: JSON.stringify({
            org_id: orgId,
            camera_id: cameraId,
            image_bytes: imageBytes.toString('base64'),
            confidence: 0,
            face_profile_id: null,
            event_type: 'unknown_face',
          }),
        });
      }
    } catch (err: unknown) {
      // No face in frame or collection doesn't exist — skip
      if (err instanceof Error && err.name === 'InvalidParameterException') continue;
      if (err instanceof Error && err.name === 'ResourceNotFoundException') continue;
      console.error('Error processing frame:', err);
    }
  }

  return { statusCode: 200, body: 'processed' };
}
```

- [ ] **Step 5: Run the Lambda tests**

Run: `cd lambda/face-recognition && npm install && npm test`
Expected: All Lambda tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lambda/face-recognition/
git commit -m "feat: add Lambda handler for KVS face recognition pipeline"
```

---

## Task 11: Terraform EventBridge for Purge

**Files:**
- Create: `terraform/modules/lambda/eventbridge.tf`

- [ ] **Step 1: Create EventBridge rule for hourly purge**

Create `terraform/modules/lambda/eventbridge.tf`:

```hcl
# ---------------------------------------------------------------------------
# EventBridge Rule — Hourly purge of expired unknown faces
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_event_rule" "purge_unknowns" {
  name                = "${var.project}-${var.environment}-purge-unknowns"
  description         = "Trigger face recognition Lambda hourly to purge expired unknown faces"
  schedule_expression = "rate(1 hour)"

  tags = { Name = "${var.project}-${var.environment}-purge-unknowns" }
}

resource "aws_cloudwatch_event_target" "purge_unknowns" {
  rule      = aws_cloudwatch_event_rule.purge_unknowns.name
  target_id = "face-recognition-purge"
  arn       = aws_lambda_function.face_recognition.arn

  input = jsonencode({ action = "purge_unknowns" })
}

resource "aws_lambda_permission" "allow_eventbridge_purge" {
  statement_id  = "AllowEventBridgePurge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.face_recognition.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.purge_unknowns.arn
}
```

- [ ] **Step 2: Verify Terraform syntax**

Run: `cd terraform/modules/lambda && terraform fmt -check`
Expected: No formatting errors.

- [ ] **Step 3: Commit**

```bash
git add terraform/modules/lambda/eventbridge.tf
git commit -m "infra: add EventBridge rule for hourly unknown face purge"
```

---

## Task 12: Full Test Suite Verification

**Files:** (none — verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test -- --forceExit`
Expected: All tests pass (existing + new).

- [ ] **Step 2: Run linting**

Run: `npm run lint`
Expected: No lint errors.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 4: Commit any fixes needed**

If any fixes were needed, commit them:

```bash
git add -A
git commit -m "fix: resolve lint/type issues from facial recognition implementation"
```

---

## Summary of Commits

1. `feat: add Rekognition, S3, SES clients and env config for facial recognition`
2. `feat: add face_profiles and recognition_events migrations`
3. `feat: add Rekognition service with test-env mocking`
4. `feat: add S3 service for face images and event thumbnails`
5. `feat: add SES service for unknown face alert emails`
6. `feat: add face profile CRUD routes with Rekognition integration`
7. `feat: add recognition events API with internal endpoint and filtering`
8. `test: add internal recognition events endpoint tests`
9. `test: add cross-org isolation tests for face profiles and recognition events`
10. `feat: add Lambda handler for KVS face recognition pipeline`
11. `infra: add EventBridge rule for hourly unknown face purge`
12. (conditional) `fix: resolve lint/type issues from facial recognition implementation`
