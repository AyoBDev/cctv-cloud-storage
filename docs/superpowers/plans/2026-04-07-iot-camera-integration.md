# IoT Camera Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate IoT Thing + certificate provisioning when cameras are registered via the API, replacing manual AWS Console setup.

**Architecture:** Extend the existing camera service with an IoT service layer that wraps `@aws-sdk/client-iot`. The API creates IoT Things on camera registration and issues certificates via a new download endpoint. Shared IoT infrastructure (IAM role, role alias, IoT policy) is managed by a new Terraform module.

**Tech Stack:** TypeScript, Fastify, `@aws-sdk/client-iot`, node-pg-migrate, Terraform, Jest

**Spec:** `docs/superpowers/specs/2026-04-07-iot-camera-integration-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/db/migrations/003_iot_columns.ts` | Create | Add IoT columns to cameras table |
| `src/services/iot.service.ts` | Create | IoT SDK wrapper (Thing CRUD, cert issuance, endpoint cache) |
| `src/plugins/aws.ts` | Modify | Add IoTClient decorator |
| `src/types/fastify.d.ts` | Modify | Declare `iot` on FastifyInstance |
| `src/config/env.ts` | Modify | Add `IOT_POLICY_NAME`, `IOT_ROLE_ALIAS` env vars |
| `src/services/camera.service.ts` | Modify | Integrate IoT Thing create/delete into camera lifecycle |
| `src/routes/cameras/index.ts` | Modify | Add `GET /:cameraId/credentials` endpoint |
| `terraform/modules/iot/main.tf` | Create | IAM role, role alias, IoT policy |
| `terraform/modules/iot/variables.tf` | Create | Module inputs |
| `terraform/modules/iot/outputs.tf` | Create | Module outputs |
| `terraform/modules/iam/main.tf` | Modify | Add IoT permissions to ECS task role |
| `terraform/environments/staging/main.tf` | Modify | Wire up iot module |
| `tests/cameras/credentials.test.ts` | Create | Credential endpoint tests |
| `tests/cameras/cameras.test.ts` | Modify | Verify IoT fields on create/delete |
| `docs/camera-setup-guide.md` | Create | Pi setup documentation |
| `postman/CCTV-Cloud-Storage.postman_collection.json` | Modify | Add credential endpoint |
| `postman/openapi.yml` | Modify | Add credential endpoint schema |

---

### Task 1: Database Migration — Add IoT Columns

**Files:**
- Create: `src/db/migrations/003_iot_columns.ts`

- [ ] **Step 1: Write the migration**

```typescript
// src/db/migrations/003_iot_columns.ts
type MigrationBuilder = import('node-pg-migrate/dist/bundle/index').MigrationBuilder;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('cameras', {
    iot_thing_name: { type: 'varchar(255)' },
    iot_certificate_id: { type: 'varchar(255)' },
    iot_certificate_arn: { type: 'varchar(512)' },
    credentials_issued: { type: 'boolean', notNull: true, default: false },
    credentials_issued_at: { type: 'timestamptz' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('cameras', [
    'iot_thing_name',
    'iot_certificate_id',
    'iot_certificate_arn',
    'credentials_issued',
    'credentials_issued_at',
  ]);
}
```

- [ ] **Step 2: Run the migration**

Run: `npm run migrate`
Expected: Migration applies successfully, output shows `003_iot_columns` applied.

- [ ] **Step 3: Verify columns exist**

Run: `psql -d cctv_test -c "\d cameras" | grep iot`
Expected: Output shows `iot_thing_name`, `iot_certificate_id`, `iot_certificate_arn`, `credentials_issued`, `credentials_issued_at` columns.

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/003_iot_columns.ts
git commit -m "feat: add IoT columns to cameras table (migration 003)"
```

---

### Task 2: Environment Config — Add IoT Variables

**Files:**
- Modify: `src/config/env.ts:4-33`

- [ ] **Step 1: Add IoT env vars to Zod schema**

In `src/config/env.ts`, add these two fields to the `envSchema` object, after the `KMS_KEY_ID` line (line 32):

```typescript
  IOT_POLICY_NAME: z.string().default(''),
  IOT_ROLE_ALIAS: z.string().default('camera-iot-role-alias'),
```

Both default to empty/safe values so tests and local dev continue to work without IoT config.

- [ ] **Step 2: Add to `.env` file**

Add these lines to your local `.env` file:

```
IOT_POLICY_NAME=
IOT_ROLE_ALIAS=camera-iot-role-alias
```

- [ ] **Step 3: Verify app still starts**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/config/env.ts
git commit -m "feat: add IOT_POLICY_NAME and IOT_ROLE_ALIAS to env config"
```

---

### Task 3: AWS Plugin — Add IoTClient

**Files:**
- Modify: `src/plugins/aws.ts:1-18`
- Modify: `src/types/fastify.d.ts:1-15`

- [ ] **Step 1: Install the AWS IoT SDK**

Run: `npm install @aws-sdk/client-iot`

- [ ] **Step 2: Add IoTClient to the AWS plugin**

Replace the entire contents of `src/plugins/aws.ts` with:

```typescript
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { KinesisVideoClient } from '@aws-sdk/client-kinesis-video';
import { KMSClient } from '@aws-sdk/client-kms';
import { IoTClient } from '@aws-sdk/client-iot';
import { env } from '@config/env';

export default fp(async function awsPlugin(app: FastifyInstance) {
  const kvs = new KinesisVideoClient({ region: env.AWS_REGION });
  const kms = new KMSClient({ region: env.AWS_REGION });
  const iot = new IoTClient({ region: env.AWS_REGION });

  app.decorate('kvs', kvs);
  app.decorate('kms', kms);
  app.decorate('iot', iot);

  app.addHook('onClose', async () => {
    kvs.destroy();
    kms.destroy();
    iot.destroy();
  });
});
```

- [ ] **Step 3: Add IoTClient to Fastify type declarations**

Replace the entire contents of `src/types/fastify.d.ts` with:

```typescript
import 'fastify';
import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';
import type { KinesisVideoClient } from '@aws-sdk/client-kinesis-video';
import type { KMSClient } from '@aws-sdk/client-kms';
import type { IoTClient } from '@aws-sdk/client-iot';

declare module 'fastify' {
  interface FastifyInstance {
    db: Sql;
    redis: Redis;
    kvs: KinesisVideoClient;
    kms: KMSClient;
    iot: IoTClient;
  }
}
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/aws.ts src/types/fastify.d.ts package.json package-lock.json
git commit -m "feat: add IoTClient to AWS plugin and Fastify types"
```

---

### Task 4: IoT Service — Create `iot.service.ts`

**Files:**
- Create: `src/services/iot.service.ts`

- [ ] **Step 1: Write the IoT service**

```typescript
// src/services/iot.service.ts
import type { IoTClient } from '@aws-sdk/client-iot';
import {
  CreateThingCommand,
  DeleteThingCommand,
  CreateKeysAndCertificateCommand,
  UpdateCertificateCommand,
  DeleteCertificateCommand,
  AttachPolicyCommand,
  DetachPolicyCommand,
  AttachThingPrincipalCommand,
  DetachThingPrincipalCommand,
  DescribeEndpointCommand,
} from '@aws-sdk/client-iot';
import { env } from '@config/env';

const isTestEnv = () => env.NODE_ENV === 'test';

let cachedEndpoint: string | null = null;

export async function createIoTThing(
  iot: IoTClient,
  thingName: string,
): Promise<string> {
  if (isTestEnv()) {
    return `arn:aws:iot:eu-west-2:000000000000:thing/${thingName}`;
  }

  const result = await iot.send(
    new CreateThingCommand({ thingName }),
  );

  if (!result.thingArn) {
    throw new Error('CreateThing returned no ARN');
  }

  return result.thingArn;
}

export async function deleteIoTThing(
  iot: IoTClient,
  thingName: string,
  policyName: string,
  certId?: string | null,
  certArn?: string | null,
): Promise<void> {
  if (isTestEnv()) return;

  // If cert was issued, clean it up first (order matters)
  if (certArn && certId) {
    // 1. Detach cert from Thing
    await iot.send(
      new DetachThingPrincipalCommand({
        thingName,
        principal: certArn,
      }),
    );

    // 2. Detach policy from cert
    await iot.send(
      new DetachPolicyCommand({
        policyName,
        target: certArn,
      }),
    );

    // 3. Revoke cert
    await iot.send(
      new UpdateCertificateCommand({
        certificateId: certId,
        newStatus: 'INACTIVE',
      }),
    );

    // 4. Delete cert
    await iot.send(
      new DeleteCertificateCommand({
        certificateId: certId,
        forceDelete: true,
      }),
    );
  }

  // 5. Delete Thing
  await iot.send(
    new DeleteThingCommand({ thingName }),
  );
}

export interface IssuedCredentials {
  certificateId: string;
  certificateArn: string;
  certificatePem: string;
  privateKey: string;
}

export async function issueCredentials(
  iot: IoTClient,
  thingName: string,
  policyName: string,
): Promise<IssuedCredentials> {
  if (isTestEnv()) {
    return {
      certificateId: 'test-cert-id',
      certificateArn: `arn:aws:iot:eu-west-2:000000000000:cert/test-cert-id`,
      certificatePem: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nTEST\n-----END RSA PRIVATE KEY-----',
    };
  }

  // 1. Create cert + keys (set as active)
  const certResult = await iot.send(
    new CreateKeysAndCertificateCommand({ setAsActive: true }),
  );

  if (!certResult.certificateId || !certResult.certificateArn ||
      !certResult.certificatePem || !certResult.keyPair?.PrivateKey) {
    throw new Error('CreateKeysAndCertificate returned incomplete data');
  }

  const { certificateId, certificateArn, certificatePem } = certResult;
  const privateKey = certResult.keyPair.PrivateKey;

  // 2. Attach IoT policy to cert
  await iot.send(
    new AttachPolicyCommand({
      policyName,
      target: certificateArn,
    }),
  );

  // 3. Attach cert to Thing
  await iot.send(
    new AttachThingPrincipalCommand({
      thingName,
      principal: certificateArn,
    }),
  );

  return { certificateId, certificateArn, certificatePem, privateKey };
}

export async function getCredentialEndpoint(
  iot: IoTClient,
): Promise<string> {
  if (isTestEnv()) {
    return 'test-endpoint.credentials.iot.eu-west-2.amazonaws.com';
  }

  if (cachedEndpoint) return cachedEndpoint;

  const result = await iot.send(
    new DescribeEndpointCommand({ endpointType: 'iot:CredentialProvider' }),
  );

  if (!result.endpointAddress) {
    throw new Error('DescribeEndpoint returned no address');
  }

  cachedEndpoint = result.endpointAddress;
  return cachedEndpoint;
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/iot.service.ts
git commit -m "feat: add IoT service for Thing CRUD, cert issuance, endpoint caching"
```

---

### Task 5: Camera Service — Integrate IoT into Camera Lifecycle

**Files:**
- Modify: `src/services/camera.service.ts:1-362`

- [ ] **Step 1: Update the Camera interface**

In `src/services/camera.service.ts`, add IoT fields to the `Camera` interface (after line 22, the `updated_at` field):

```typescript
  iot_thing_name: string | null;
  iot_certificate_id: string | null;
  iot_certificate_arn: string | null;
  credentials_issued: boolean;
  credentials_issued_at: Date | null;
```

- [ ] **Step 2: Add IoT import**

At the top of `src/services/camera.service.ts`, add the import after the existing imports (after line 8):

```typescript
import type { IoTClient } from '@aws-sdk/client-iot';
import { createIoTThing, deleteIoTThing } from '@services/iot.service';
```

- [ ] **Step 3: Update `createCamera` to create IoT Thing**

The `createCamera` function signature needs `iot: IoTClient` added. Replace the entire function (lines 79-146) with:

```typescript
export async function createCamera(
  db: Sql,
  redis: Redis,
  kvs: KinesisVideoClient,
  kms: KMSClient,
  iot: IoTClient,
  orgId: string,
  data: { name: string; location?: string; timezone?: string; rtsp_url?: string },
): Promise<CameraResponse> {
  // Insert with a placeholder stream name first to get the camera ID
  const rows = await db<Camera[]>`
    INSERT INTO cameras (org_id, name, location, timezone, kvs_stream_name)
    VALUES (
      ${orgId},
      ${data.name},
      ${data.location ?? null},
      ${data.timezone ?? 'UTC'},
      'pending'
    )
    RETURNING *
  `;

  const camera = rows[0];
  if (!camera) throw new Error('Insert returned no rows');

  const streamName = `${orgId}-${camera.id}`;
  let streamArn: string | null = null;
  let iotThingName: string | null = null;

  // Provision KVS stream (skip in test)
  if (!isTestEnv()) {
    try {
      const result = await kvs.send(
        new CreateStreamCommand({
          StreamName: streamName,
          DataRetentionInHours: 24,
        }),
      );
      streamArn = result.StreamARN ?? null;
    } catch (err) {
      // Clean up DB row on KVS failure
      await db`DELETE FROM cameras WHERE id = ${camera.id}`;
      throw err;
    }
  }

  // Create IoT Thing (skip in test)
  if (!isTestEnv()) {
    try {
      await createIoTThing(iot, streamName);
      iotThingName = streamName;
    } catch (err) {
      // Rollback: delete KVS stream + DB row
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

  // Update with real stream name, ARN, IoT Thing name, and encrypted URL
  const updated = await db<Camera[]>`
    UPDATE cameras
    SET kvs_stream_name = ${streamName},
        kvs_stream_arn = ${streamArn},
        iot_thing_name = ${iotThingName},
        rtsp_url_encrypted = ${encryptedUrl},
        status = 'online'
    WHERE id = ${camera.id}
    RETURNING *
  `;

  const result = updated[0];
  if (!result) throw new Error('Update returned no rows');

  await invalidateOrgCameraCache(redis, orgId);

  return toCameraResponse(result);
}
```

- [ ] **Step 4: Update `deactivateCamera` to clean up IoT resources**

The `deactivateCamera` function signature needs `iot: IoTClient` added. Replace the entire function (lines 266-300) with:

```typescript
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
```

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: Errors in `src/routes/cameras/index.ts` because `createCamera` and `deactivateCamera` now expect `iot` parameter. This is expected — we'll fix in the next step.

- [ ] **Step 6: Commit**

```bash
git add src/services/camera.service.ts
git commit -m "feat: integrate IoT Thing create/delete into camera lifecycle"
```

---

### Task 6: Camera Routes — Update Calls + Add Credentials Endpoint

**Files:**
- Modify: `src/routes/cameras/index.ts:1-265`

- [ ] **Step 1: Update `createCamera` call to pass `app.iot`**

In `src/routes/cameras/index.ts`, update the `POST /` handler (around line 86). Change:

```typescript
      const camera = await createCamera(
        app.db,
        app.redis,
        app.kvs,
        app.kms,
        request.user.org_id!,
        data,
      );
```

To:

```typescript
      const camera = await createCamera(
        app.db,
        app.redis,
        app.kvs,
        app.kms,
        app.iot,
        request.user.org_id!,
        data,
      );
```

- [ ] **Step 2: Update `deactivateCamera` call to pass `app.iot`**

In the `DELETE /:cameraId` handler (around line 261). Change:

```typescript
      await deactivateCamera(app.db, app.redis, app.kvs, request.user.org_id!, params.cameraId);
```

To:

```typescript
      await deactivateCamera(app.db, app.redis, app.kvs, app.iot, request.user.org_id!, params.cameraId);
```

- [ ] **Step 3: Add the credentials endpoint imports**

At the top of `src/routes/cameras/index.ts`, add to the imports:

```typescript
import { issueCredentials, getCredentialEndpoint } from '@services/iot.service';
import { env } from '@config/env';
import { AppError } from '@utils/errors';
```

- [ ] **Step 4: Add the `GET /:cameraId/credentials` endpoint**

Add this route inside the `cameraRoutes` function, after the DELETE endpoint (before the closing `}`):

```typescript
  // GET /api/v1/cameras/:cameraId/credentials
  app.get(
    '/:cameraId/credentials',
    {
      schema: {
        params: {
          type: 'object',
          required: ['cameraId'],
          properties: { cameraId: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              device_cert: { type: 'string' },
              private_key: { type: 'string' },
              root_ca_url: { type: 'string' },
              iot_credential_endpoint: { type: 'string' },
              kvs_stream_name: { type: 'string' },
              role_alias: { type: 'string' },
              region: { type: 'string' },
            },
          },
        },
      },
      preHandler: [requireOrgAdmin],
    },
    async (request, reply) => {
      const params = cameraIdParamsSchema.parse(request.params);
      const orgId = request.user.org_id!;

      // Fetch camera and verify ownership
      const rows = await app.db<Array<{
        id: string;
        org_id: string;
        iot_thing_name: string | null;
        credentials_issued: boolean;
        is_active: boolean;
      }>>`
        SELECT id, org_id, iot_thing_name, credentials_issued, is_active
        FROM cameras
        WHERE id = ${params.cameraId} AND is_active = true
      `;

      const camera = rows[0];
      if (!camera) throw AppError.notFound('Camera not found');
      if (camera.org_id !== orgId) throw AppError.forbidden('Access denied');
      if (camera.credentials_issued) {
        throw AppError.conflict('Credentials already issued. Use rotate endpoint to reissue.');
      }
      if (!camera.iot_thing_name) {
        throw AppError.badRequest('Camera has no IoT Thing provisioned');
      }

      // Issue credentials
      const creds = await issueCredentials(
        app.iot,
        camera.iot_thing_name,
        env.IOT_POLICY_NAME,
      );

      // Get cached credential endpoint
      const endpoint = await getCredentialEndpoint(app.iot);

      // Update DB with cert details
      await app.db`
        UPDATE cameras
        SET iot_certificate_id = ${creds.certificateId},
            iot_certificate_arn = ${creds.certificateArn},
            credentials_issued = true,
            credentials_issued_at = now()
        WHERE id = ${params.cameraId}
      `;

      return reply.code(200).send({
        device_cert: creds.certificatePem,
        private_key: creds.privateKey,
        root_ca_url: 'https://www.amazontrust.com/repository/AmazonRootCA1.pem',
        iot_credential_endpoint: endpoint,
        kvs_stream_name: camera.iot_thing_name,
        role_alias: env.IOT_ROLE_ALIAS,
        region: env.AWS_REGION,
      });
    },
  );
```

- [ ] **Step 5: Add `conflict` method to AppError if not present**

Check `src/utils/errors.ts` for a `conflict` static method. If it doesn't exist, add it:

```typescript
  static conflict(message: string): AppError {
    return new AppError(409, 'CONFLICT', message);
  }

  static badRequest(message: string): AppError {
    return new AppError(400, 'BAD_REQUEST', message);
  }
```

- [ ] **Step 6: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/routes/cameras/index.ts src/utils/errors.ts
git commit -m "feat: add GET /cameras/:id/credentials endpoint and pass IoT client to camera routes"
```

---

### Task 7: Tests — Credential Endpoint

**Files:**
- Create: `tests/cameras/credentials.test.ts`

- [ ] **Step 1: Write the credential endpoint tests**

```typescript
// tests/cameras/credentials.test.ts
import { buildTestApp, closeTestApp } from '../helpers/build-app';
import { createOrgAndLogin, loginAsSuperAdmin } from '../helpers/org-auth';
import type { FastifyInstance } from 'fastify';

describe('Camera Credentials', () => {
  let app: FastifyInstance;
  let superAdminToken: string;
  let orgId: string;
  let orgAdminAccessToken: string;
  let viewerAccessToken: string;
  let cameraId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    superAdminToken = await loginAsSuperAdmin(app);

    const org = await createOrgAndLogin(app, superAdminToken, 'creds');
    orgId = org.orgId;
    orgAdminAccessToken = org.orgAdminAccessToken;

    // Create a viewer
    const viewerEmail = `viewer-creds-${Date.now()}@example.com`;
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

    // Create a camera for testing
    const camRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cameras',
      headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      payload: { name: 'Credentials Test Camera' },
    });
    cameraId = camRes.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('GET /api/v1/cameras/:cameraId/credentials', () => {
    it('returns 200 with credential bundle on first download', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/credentials`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        device_cert: string;
        private_key: string;
        root_ca_url: string;
        iot_credential_endpoint: string;
        kvs_stream_name: string;
        role_alias: string;
        region: string;
      }>();

      expect(body.device_cert).toContain('BEGIN CERTIFICATE');
      expect(body.private_key).toContain('BEGIN RSA PRIVATE KEY');
      expect(body.root_ca_url).toContain('amazontrust.com');
      expect(body.iot_credential_endpoint).toBeTruthy();
      expect(body.kvs_stream_name).toContain(orgId);
      expect(body.role_alias).toBeTruthy();
      expect(body.region).toBeTruthy();
    });

    it('returns 409 on second download attempt', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/credentials`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json<{ error: { code: string; message: string } }>();
      expect(body.error.message).toContain('already issued');
    });

    it('returns 403 for viewer (requireOrgAdmin)', async () => {
      // Create a fresh camera so credentials haven't been issued
      const camRes = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'Viewer Creds Test' },
      });
      const freshCamId = camRes.json<{ id: string }>().id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${freshCamId}/credentials`,
        headers: { authorization: `Bearer ${viewerAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 403 for wrong org', async () => {
      // Create a second org
      const org2 = await createOrgAndLogin(app, superAdminToken, 'creds-org2');

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/credentials`,
        headers: { authorization: `Bearer ${org2.orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 404 for non-existent camera', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/cameras/00000000-0000-0000-0000-000000000000/credentials',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/cameras/${cameraId}/credentials`,
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test -- tests/cameras/credentials.test.ts`
Expected: All 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/cameras/credentials.test.ts
git commit -m "test: add credential endpoint tests (200, 409, 403, 404, 401)"
```

---

### Task 8: Tests — Verify IoT Fields on Camera Create/Delete

**Files:**
- Modify: `tests/cameras/cameras.test.ts`

- [ ] **Step 1: Add test for IoT fields on camera creation**

Add this test inside the `POST /api/v1/cameras` describe block in `tests/cameras/cameras.test.ts`, after the existing tests:

```typescript
    it('stores iot_thing_name in DB on creation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'IoT Thing Test Camera' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; kvs_stream_name: string }>();

      // Verify IoT fields in DB directly
      const dbRows = await app.db<Array<{ iot_thing_name: string | null; credentials_issued: boolean }>>`
        SELECT iot_thing_name, credentials_issued FROM cameras WHERE id = ${body.id}
      `;
      expect(dbRows[0]?.iot_thing_name).toBe(body.kvs_stream_name);
      expect(dbRows[0]?.credentials_issued).toBe(false);
    });
```

- [ ] **Step 2: Add test for IoT cleanup on camera deactivation**

Add this test inside the `DELETE /api/v1/cameras/:cameraId` describe block:

```typescript
    it('clears camera status on deactivation (IoT cleanup skipped in test)', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/cameras',
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
        payload: { name: 'IoT Delete Test Camera' },
      });
      const { id: camId } = createRes.json<{ id: string }>();

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/cameras/${camId}`,
        headers: { authorization: `Bearer ${orgAdminAccessToken}` },
      });
      expect(deleteRes.statusCode).toBe(204);

      // Verify camera is inactive in DB
      const dbRows = await app.db<Array<{ status: string; is_active: boolean }>>`
        SELECT status, is_active FROM cameras WHERE id = ${camId}
      `;
      expect(dbRows[0]?.status).toBe('inactive');
      expect(dbRows[0]?.is_active).toBe(false);
    });
```

- [ ] **Step 3: Run all camera tests**

Run: `npm test -- tests/cameras/cameras.test.ts`
Expected: All existing + 2 new tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/cameras/cameras.test.ts
git commit -m "test: verify IoT fields on camera create/delete"
```

---

### Task 9: Run Full Test Suite

**Files:** None (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass including existing cross-org isolation tests.

- [ ] **Step 2: Run the linter**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 4: Fix any failures**

If any tests fail, fix the root cause. Common issues:
- Camera tests may need `app.iot` mock — check if `buildTestApp` provides it
- Cross-org isolation tests should be unaffected since `CameraResponse` hasn't changed

---

### Task 10: Terraform — New IoT Module

**Files:**
- Create: `terraform/modules/iot/main.tf`
- Create: `terraform/modules/iot/variables.tf`
- Create: `terraform/modules/iot/outputs.tf`

- [ ] **Step 1: Create `terraform/modules/iot/variables.tf`**

```hcl
variable "project" {
  description = "Project name"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "aws_account_id" {
  description = "AWS account ID"
  type        = string
}
```

- [ ] **Step 2: Create `terraform/modules/iot/main.tf`**

```hcl
# ---------------------------------------------------------------------------
# IAM Role for IoT Credential Provider
# (assumed by IoT devices via certificate auth to get temporary KVS credentials)
# ---------------------------------------------------------------------------
resource "aws_iam_role" "camera_iot" {
  name = "${var.project}-${var.environment}-camera-iot-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "credentials.iot.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "camera_iot_kvs" {
  name = "kvs-streaming-permissions"
  role = aws_iam_role.camera_iot.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "kinesisvideo:DescribeStream",
        "kinesisvideo:PutMedia",
        "kinesisvideo:TagStream",
        "kinesisvideo:GetDataEndpoint"
      ]
      Resource = "arn:aws:kinesisvideo:${var.aws_region}:${var.aws_account_id}:stream/$${credentials-iot:ThingName}/*"
    }]
  })
}

# ---------------------------------------------------------------------------
# IoT Role Alias
# (maps the IAM role to IoT credential provider)
# ---------------------------------------------------------------------------
resource "aws_iot_role_alias" "camera" {
  alias    = "${var.project}-${var.environment}-camera-iot-role-alias"
  role_arn = aws_iam_role.camera_iot.arn
}

# ---------------------------------------------------------------------------
# IoT Policy
# (allows devices to connect and assume role via certificate)
# ---------------------------------------------------------------------------
resource "aws_iot_policy" "camera_streaming" {
  name = "${var.project}-${var.environment}-CameraStreamingPolicy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "iot:Connect"
        Resource = aws_iot_role_alias.camera.arn
      },
      {
        Effect   = "Allow"
        Action   = "iot:AssumeRoleWithCertificate"
        Resource = aws_iot_role_alias.camera.arn
      }
    ]
  })
}
```

- [ ] **Step 3: Create `terraform/modules/iot/outputs.tf`**

```hcl
output "iot_role_alias_arn" {
  description = "ARN of the IoT role alias"
  value       = aws_iot_role_alias.camera.arn
}

output "iot_policy_name" {
  description = "Name of the IoT policy to attach to device certificates"
  value       = aws_iot_policy.camera_streaming.name
}

output "iot_role_arn" {
  description = "ARN of the IAM role used by IoT credential provider"
  value       = aws_iam_role.camera_iot.arn
}
```

- [ ] **Step 4: Validate terraform syntax**

Run: `cd terraform/modules/iot && terraform fmt && terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 5: Commit**

```bash
git add terraform/modules/iot/
git commit -m "feat: add Terraform IoT module (IAM role, role alias, IoT policy)"
```

---

### Task 11: Terraform — Add IoT Permissions to ECS Task Role

**Files:**
- Modify: `terraform/modules/iam/main.tf:79-153`

- [ ] **Step 1: Add IoT statement to ECS task role policy**

In `terraform/modules/iam/main.tf`, add a new statement block inside the `aws_iam_role_policy.ecs_task_app` policy (after the CloudWatch Logs statement, before the closing `]` on line 151):

```hcl
      # IoT — manage Things and certificates for camera provisioning
      {
        Effect = "Allow"
        Action = [
          "iot:CreateThing",
          "iot:DeleteThing",
          "iot:CreateKeysAndCertificate",
          "iot:UpdateCertificate",
          "iot:DeleteCertificate",
          "iot:AttachPolicy",
          "iot:DetachPolicy",
          "iot:AttachThingPrincipal",
          "iot:DetachThingPrincipal",
          "iot:DescribeEndpoint"
        ]
        Resource = "*"
      }
```

- [ ] **Step 2: Format and validate**

Run: `cd terraform/modules/iam && terraform fmt`
Expected: File formatted.

- [ ] **Step 3: Commit**

```bash
git add terraform/modules/iam/main.tf
git commit -m "feat: add IoT permissions to ECS task role for camera provisioning"
```

---

### Task 12: Terraform — Wire IoT Module into Staging

**Files:**
- Modify: `terraform/environments/staging/main.tf:130-142`

- [ ] **Step 1: Add the IoT module to staging**

In `terraform/environments/staging/main.tf`, add this block after the Lambda module (after line 130, before the Notifications comment):

```hcl
# ---------------------------------------------------------------------------
# IoT (camera device provisioning)
# ---------------------------------------------------------------------------
module "iot" {
  source = "../../modules/iot"

  project        = local.project
  environment    = local.environment
  aws_region     = var.aws_region
  aws_account_id = data.aws_caller_identity.current.account_id
}
```

- [ ] **Step 2: Format**

Run: `cd terraform/environments/staging && terraform fmt`
Expected: File formatted.

- [ ] **Step 3: Commit**

```bash
git add terraform/environments/staging/main.tf
git commit -m "feat: wire IoT module into staging environment"
```

---

### Task 13: Documentation — Camera Setup Guide

**Files:**
- Create: `docs/camera-setup-guide.md`

- [ ] **Step 1: Write the camera setup guide**

```markdown
# Camera Setup Guide

How to connect an RTSP IP camera to the CCTV Cloud Storage platform via a Raspberry Pi and AWS Kinesis Video Streams.

## Prerequisites

- Raspberry Pi 3B+ or later (Pi 4 recommended for multiple cameras)
- RTSP-capable IP camera on the same local network as the Pi
- Camera's RTSP URL verified (test with VLC: Media > Open Network Stream)
- An org_admin account on the CCTV Cloud Storage platform

## Phase 1: Prepare the Raspberry Pi

### Install Dependencies

```bash
sudo apt-get update
sudo apt-get install -y cmake g++ libssl-dev libcurl4-openssl-dev \
  liblog4cplus-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-plugins-base-apps gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-ugly gstreamer1.0-tools
```

### Build the KVS Producer SDK

```bash
git clone https://github.com/awslabs/amazon-kinesis-video-streams-producer-sdk-cpp.git
cd amazon-kinesis-video-streams-producer-sdk-cpp
mkdir build && cd build
cmake .. -DBUILD_GSTREAMER_PLUGIN=ON -DBUILD_DEPENDENCIES=ON -DBUILD_SAMPLES=ON
make -j4
```

This takes several minutes on a Pi. Verify the build produced `kvs_gstreamer_sample` and `libgstkvssink.so`:

```bash
ls kvs_gstreamer_sample libgstkvssink.so
```

### Disable IPv6 (if needed)

If your network doesn't have working IPv6, the SDK will try IPv6 first and time out. Disable it:

```bash
sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1
sudo sysctl -w net.ipv6.conf.default.disable_ipv6=1

# Make permanent
echo "net.ipv6.conf.all.disable_ipv6 = 1" | sudo tee -a /etc/sysctl.conf
echo "net.ipv6.conf.default.disable_ipv6 = 1" | sudo tee -a /etc/sysctl.conf
```

## Phase 2: Register the Camera

### Step 1 — Create the Camera via API

As an org_admin, register the camera:

```bash
curl -X POST https://your-api-url/api/v1/cameras \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Front Door Camera",
    "location": "Main Entrance",
    "timezone": "Europe/London",
    "rtsp_url": "rtsp://user:pass@192.168.1.100:554/stream"
  }'
```

Note the `id` from the response — you'll need it in the next step.

### Step 2 — Download Credentials

Download the IoT credentials for this camera:

```bash
curl -X GET https://your-api-url/api/v1/cameras/CAMERA_ID/credentials \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -o credentials.json
```

The response contains:
- `device_cert` — the device certificate PEM
- `private_key` — the private key PEM
- `root_ca_url` — URL to download the Amazon Root CA
- `iot_credential_endpoint` — the IoT credential provider endpoint
- `kvs_stream_name` — the KVS stream name for this camera
- `role_alias` — the IoT role alias
- `region` — the AWS region

**This is a one-time download.** The credentials cannot be downloaded again. Store them securely.

### Step 3 — Save Credentials to Files

On the Pi, create a `certs` directory and save the credentials:

```bash
mkdir -p ~/certs

# Extract and save from credentials.json (use jq or manually copy)
jq -r '.device_cert' credentials.json > ~/certs/device.crt
jq -r '.private_key' credentials.json > ~/certs/private.key

# Download the Root CA
curl -o ~/certs/root-ca.pem $(jq -r '.root_ca_url' credentials.json)
```

## Phase 3: Start Streaming

### Set Environment Variables

```bash
export AWS_DEFAULT_REGION=eu-west-2
export CERT_PATH=$HOME/certs/device.crt
export PRIVATE_KEY_PATH=$HOME/certs/private.key
export CA_CERT_PATH=$HOME/certs/root-ca.pem
export ROLE_ALIAS=camera-iot-role-alias
export IOT_GET_CREDENTIAL_ENDPOINT=<iot_credential_endpoint from credentials.json>
```

### Run the Producer

```bash
cd ~/amazon-kinesis-video-streams-producer-sdk-cpp/build
./kvs_gstreamer_sample <kvs_stream_name> <rtsp_url>
```

Replace `<kvs_stream_name>` and `<rtsp_url>` with values from the camera registration.

### Verify

1. Open the AWS Console > Kinesis Video Streams > your stream
2. Click **Media playback** to see the live feed
3. Check the **Monitoring** tab for PutMedia activity
4. Call `GET /api/v1/cameras/CAMERA_ID` to verify status is `online`

## Multi-Stream Setup

To stream multiple cameras from one device, run one producer process per camera. Each camera has its own IoT Thing, certificate, and KVS stream.

### Register All Cameras

Register each camera via the API and download credentials for each one:

```bash
# For each camera, save certs to separate directories
mkdir -p ~/certs/camera1 ~/certs/camera2

# Download and extract credentials for each camera
# ... (repeat Phase 2, Steps 2-3 for each camera)
```

### Run Multiple Producers

Create a script `~/start-cameras.sh`:

```bash
#!/bin/bash

# Camera 1
(
  export AWS_DEFAULT_REGION=eu-west-2
  export CERT_PATH=$HOME/certs/camera1/device.crt
  export PRIVATE_KEY_PATH=$HOME/certs/camera1/private.key
  export CA_CERT_PATH=$HOME/certs/camera1/root-ca.pem
  export ROLE_ALIAS=camera-iot-role-alias
  export IOT_GET_CREDENTIAL_ENDPOINT=<endpoint>
  cd ~/amazon-kinesis-video-streams-producer-sdk-cpp/build
  ./kvs_gstreamer_sample <stream-name-1> <rtsp-url-1> &
)

# Camera 2
(
  export AWS_DEFAULT_REGION=eu-west-2
  export CERT_PATH=$HOME/certs/camera2/device.crt
  export PRIVATE_KEY_PATH=$HOME/certs/camera2/private.key
  export CA_CERT_PATH=$HOME/certs/camera2/root-ca.pem
  export ROLE_ALIAS=camera-iot-role-alias
  export IOT_GET_CREDENTIAL_ENDPOINT=<endpoint>
  cd ~/amazon-kinesis-video-streams-producer-sdk-cpp/build
  ./kvs_gstreamer_sample <stream-name-2> <rtsp-url-2> &
)

echo "All cameras started. Use 'jobs' to check status."
wait
```

```bash
chmod +x ~/start-cameras.sh
./start-cameras.sh
```

### Resource Guidelines

| Device | Max Concurrent Streams |
|--------|----------------------|
| Raspberry Pi 3B+ | 2 |
| Raspberry Pi 4 (4GB) | 4-6 |
| Mini PC / NUC | 8+ |

**Fault isolation:** Each process is independent. If one camera's RTSP feed drops, only that process stops — the others keep streaming.

**For 10+ cameras** on a single device, consider using the `libgstkvssink.so` GStreamer plugin in a custom pipeline for reduced memory overhead. See the [KVS Producer SDK documentation](https://github.com/awslabs/amazon-kinesis-video-streams-producer-sdk-cpp) for details.

## Troubleshooting

### Stream not appearing in KVS
- Verify all environment variables are set correctly
- Confirm the stream name matches exactly (it's `{orgId}-{cameraId}`)
- Check that the credential endpoint matches your region

### Video not playing in browser
- Check the Monitoring tab for PutMedia activity — if present, the stream works
- Try Chrome (best codec support for KVS HLS)

### Authentication errors
- Ensure certificate file paths are absolute (not relative)
- Verify the credential endpoint is correct for your region
- Re-check that credentials were downloaded before they expire

### `Timeout was reached` / `Unable to create IoT Credential provider`
- This is usually IPv6 on the Pi interfering. See the "Disable IPv6" section above.
- Test manually:
  ```bash
  curl -v https://<endpoint>.credentials.iot.eu-west-2.amazonaws.com/role-aliases/<alias>/credentials \
    --cert ~/certs/device.crt \
    --key ~/certs/private.key \
    --cacert ~/certs/root-ca.pem
  ```
  If curl returns HTTP 200 but the SDK times out, IPv6 is the culprit.
```

- [ ] **Step 2: Commit**

```bash
git add docs/camera-setup-guide.md
git commit -m "docs: add camera setup guide for Pi + multi-stream"
```

---

### Task 14: Postman Collection + OpenAPI Update

**Files:**
- Modify: `postman/CCTV-Cloud-Storage.postman_collection.json`
- Modify: `postman/openapi.yml`

- [ ] **Step 1: Add credential endpoint to Postman collection**

Add a new request to the Cameras folder in the Postman collection JSON. The request should be:
- Name: `Download Camera Credentials`
- Method: `GET`
- URL: `{{baseUrl}}/api/v1/cameras/{{cameraId}}/credentials`
- Auth: Bearer `{{orgAccessToken}}`
- Description: `Download IoT credentials for a camera. One-time download — returns 409 if already issued.`

Add a test script that saves the response for reference:
```javascript
if (pm.response.code === 200) {
    const body = pm.response.json();
    pm.collectionVariables.set("iotCredentialEndpoint", body.iot_credential_endpoint);
    pm.collectionVariables.set("kvsStreamName", body.kvs_stream_name);
}
```

- [ ] **Step 2: Add credential endpoint to OpenAPI spec**

Add to `postman/openapi.yml` under the cameras paths:

```yaml
  /api/v1/cameras/{cameraId}/credentials:
    get:
      summary: Download camera IoT credentials
      description: >
        Generate and download IoT certificates for a camera.
        One-time download — returns 409 if credentials were already issued.
      tags:
        - Cameras
      security:
        - bearerAuth: []
      parameters:
        - name: cameraId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: Credential bundle
          content:
            application/json:
              schema:
                type: object
                properties:
                  device_cert:
                    type: string
                    description: Device certificate PEM
                  private_key:
                    type: string
                    description: Private key PEM
                  root_ca_url:
                    type: string
                    description: URL to download Amazon Root CA
                  iot_credential_endpoint:
                    type: string
                    description: IoT credential provider endpoint
                  kvs_stream_name:
                    type: string
                    description: KVS stream name for this camera
                  role_alias:
                    type: string
                    description: IoT role alias name
                  region:
                    type: string
                    description: AWS region
        '401':
          description: Unauthorized
        '403':
          description: Forbidden — wrong org or not org_admin
        '404':
          description: Camera not found
        '409':
          description: Credentials already issued
```

- [ ] **Step 3: Commit**

```bash
git add postman/CCTV-Cloud-Storage.postman_collection.json postman/openapi.yml
git commit -m "docs: add credential endpoint to Postman collection and OpenAPI spec"
```

---

### Task 15: Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Run lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: No errors.

- [ ] **Step 3: Verify Terraform validates**

Run: `cd terraform/environments/staging && terraform init -backend=false && terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 4: Review all changes**

Run: `git log --oneline --since="today"`
Expected: Commits for each task in order.

- [ ] **Step 5: Commit any remaining fixes**

If any fixes were needed, commit them now.
