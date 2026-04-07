# IoT Camera Integration — Design Spec

**Date:** 2026-04-07
**Status:** Draft
**Scope:** Full API-driven IoT provisioning for RTSP-to-KVS camera streaming

---

## Overview

Integrate AWS IoT Core into the CCTV Cloud Storage platform so that camera registration through the API automatically provisions all AWS resources needed for a Raspberry Pi (or similar device) to stream RTSP video to Kinesis Video Streams. This replaces the manual AWS Console setup described in the original RTSP_to_KVS_Guide.md.

### Goals

1. When an org admin registers a camera, the API creates the KVS stream **and** the IoT Thing automatically.
2. A separate credential download endpoint generates IoT certificates on demand — one-time download, org-admin-only.
3. When a camera is deactivated, the API cleans up all IoT resources (Thing, certificate, policy attachment).
4. Shared IoT infrastructure (IAM role, role alias, IoT policy) is managed via a new Terraform module.
5. Documentation covers end-to-end Pi setup using API-provisioned credentials, including multi-stream.

### Out of Scope

- Credential rotation endpoint (`POST /api/v1/cameras/:id/credentials/rotate`) — DB schema supports it, implementation is future work.
- IoT Device Shadow for push-based config — future scaling path.
- WebRTC fallback for live view — separate sprint concern.

---

## 1. Camera Lifecycle (Updated Flow)

### 1.1 Registration — `POST /api/v1/cameras`

Existing flow plus IoT Thing creation:

1. Insert camera DB record (status: `provisioning`)
2. Create KVS stream: `{orgId}-{cameraId}`
3. **NEW:** Create IoT Thing with the same name: `{orgId}-{cameraId}`
4. Encrypt & store RTSP URL via KMS (existing)
5. Update DB with `kvs_stream_arn`, `iot_thing_name`, set status to `online`

**Rollback on failure:**
- If IoT Thing creation fails → delete KVS stream → delete DB row
- If KVS stream creation fails → delete DB row (existing behavior)

IoT Thing creation is skipped in test environment (`env.NODE_ENV === 'test'`), same as KVS.

### 1.2 Credential Download — `GET /api/v1/cameras/:cameraId/credentials`

New endpoint. Auth: `requireOrgAdmin`.

1. Fetch camera, verify `org_id` matches, verify `credentials_issued === false`
2. `CreateKeysAndCertificate` (set as active) → returns cert PEM, public key, private key, cert ID, cert ARN
3. `AttachPolicy` — attach `IOT_POLICY_NAME` to cert ARN
4. `AttachThingPrincipal` — attach cert ARN to IoT Thing
5. `DescribeEndpoint` (type `iot:CredentialProvider`) — cached, account-wide
6. Update DB: `iot_certificate_id`, `iot_certificate_arn`, `credentials_issued = true`, `credentials_issued_at = now()`
7. Return response

**Response (200):**
```json
{
  "device_cert": "-----BEGIN CERTIFICATE-----\n...",
  "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...",
  "root_ca_url": "https://www.amazontrust.com/repository/AmazonRootCA1.pem",
  "iot_credential_endpoint": "xxxx.credentials.iot.eu-west-2.amazonaws.com",
  "kvs_stream_name": "{orgId}-{cameraId}",
  "role_alias": "camera-iot-role-alias",
  "region": "eu-west-2"
}
```

**Error responses:**
- `404` — camera not found or inactive
- `403` — wrong org
- `409` — credentials already issued ("Credentials already issued. Use rotate endpoint to reissue.")

**Why `root_ca_url` instead of PEM content?** Amazon Root CA is public, doesn't change, and the operator can curl it. Keeps the response smaller.

### 1.3 Deactivation — `DELETE /api/v1/cameras/:cameraId`

Existing flow plus IoT cleanup. If credentials were issued (`iot_certificate_arn` is not null):

1. `DetachThingPrincipal` — detach cert ARN from Thing
2. `DetachPolicy` — detach IoT policy from cert ARN
3. `UpdateCertificate` — set to `INACTIVE`
4. `DeleteCertificate`
5. `DeleteThing`
6. Delete KVS stream (existing)
7. Deactivate DB record (existing)

Order matters: cannot delete a Thing with an attached cert, or delete a cert with an attached policy.

IoT cleanup is skipped in test environment.

---

## 2. Database Schema Changes

Migration: `003_iot_columns.ts`

New columns on the `cameras` table:

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `iot_thing_name` | `VARCHAR(255)` | `NULL` | IoT Thing name (same as `kvs_stream_name`) |
| `iot_certificate_id` | `VARCHAR(255)` | `NULL` | AWS certificate ID (for revocation) |
| `iot_certificate_arn` | `VARCHAR(512)` | `NULL` | AWS certificate ARN (for detach operations) |
| `credentials_issued` | `BOOLEAN` | `false` | Whether certs have been downloaded |
| `credentials_issued_at` | `TIMESTAMPTZ` | `NULL` | When certs were first downloaded |

**Why both `iot_certificate_id` and `iot_certificate_arn`?** IoT SDK uses certificate ID for some operations (`UpdateCertificate`, `DeleteCertificate`) and ARN for others (`DetachPolicy`, `DetachThingPrincipal`). Storing both avoids extra API calls.

**Why `iot_thing_name` when it matches `kvs_stream_name`?** Explicit storage avoids assumptions. If naming conventions ever diverge, the data is correct. Self-documenting for cleanup queries.

---

## 3. AWS SDK Changes

### 3.1 AWS Plugin (`src/plugins/aws.ts`)

Add `IoTClient` from `@aws-sdk/client-iot` alongside existing `KinesisVideoClient` and `KMSClient`:

```typescript
import { IoTClient } from '@aws-sdk/client-iot';

// In plugin:
const iot = new IoTClient({ region: env.AWS_REGION });
app.decorate('iot', iot);

// In onClose hook:
iot.destroy();
```

Update `src/types/fastify.d.ts` to declare `iot: IoTClient` on the FastifyInstance.

### 3.2 IoT SDK Commands Used

| Command | Used In | Purpose |
|---------|---------|---------|
| `CreateThingCommand` | `createCamera` | Create IoT Thing |
| `DeleteThingCommand` | `deactivateCamera` | Delete IoT Thing |
| `CreateKeysAndCertificateCommand` | `issueCredentials` | Generate cert + keys |
| `UpdateCertificateCommand` | `deactivateCamera` | Revoke cert (set INACTIVE) |
| `DeleteCertificateCommand` | `deactivateCamera` | Delete cert |
| `AttachPolicyCommand` | `issueCredentials` | Attach IoT policy to cert |
| `DetachPolicyCommand` | `deactivateCamera` | Detach policy from cert |
| `AttachThingPrincipalCommand` | `issueCredentials` | Attach cert to Thing |
| `DetachThingPrincipalCommand` | `deactivateCamera` | Detach cert from Thing |
| `DescribeEndpointCommand` | `issueCredentials` | Get IoT credential endpoint |

---

## 4. Service Layer

### 4.1 New Service: `src/services/iot.service.ts`

Encapsulates all IoT SDK calls. Keeps `camera.service.ts` focused on camera business logic.

**Functions:**

```typescript
// Create an IoT Thing. Returns Thing ARN.
createIoTThing(iot: IoTClient, thingName: string): Promise<string>

// Full IoT cleanup: detach cert from Thing, detach policy, revoke cert, delete cert, delete Thing.
// Handles cases where cert was never issued (certId/certArn are null).
deleteIoTThing(
  iot: IoTClient,
  thingName: string,
  policyName: string,
  certId?: string | null,
  certArn?: string | null
): Promise<void>

// Generate cert, attach policy + Thing, return cert bundle.
issueCredentials(
  iot: IoTClient,
  thingName: string,
  policyName: string
): Promise<{
  certificateId: string;
  certificateArn: string;
  certificatePem: string;
  privateKey: string;
}>

// Get IoT credential provider endpoint. Cached after first call.
getCredentialEndpoint(iot: IoTClient): Promise<string>
```

All functions skip execution and return mock values when `env.NODE_ENV === 'test'`.

### 4.2 Modified: `src/services/camera.service.ts`

**`createCamera`** — after KVS stream creation, call `createIoTThing()`. Store `iot_thing_name` in DB. Add rollback: if Thing creation fails, delete KVS stream and DB row.

**`deactivateCamera`** — after verifying ownership, call `deleteIoTThing()` with cert details from DB before deleting KVS stream. IoT cleanup happens first because KVS stream deletion is the existing final step.

**`getCameraById`** — no changes needed. IoT fields are internal; they don't appear in `CameraResponse`.

### 4.3 Camera Interface Updates

Add IoT fields to the `Camera` interface:

```typescript
iot_thing_name: string | null;
iot_certificate_id: string | null;
iot_certificate_arn: string | null;
credentials_issued: boolean;
credentials_issued_at: Date | null;
```

`CameraResponse` remains unchanged — IoT internals are not exposed in camera list/detail endpoints. The credential endpoint has its own response shape.

---

## 5. Route Changes

### 5.1 New Credential Route in `src/routes/cameras/index.ts`

Added directly to the existing camera routes file — follows the established pattern where all camera endpoints live in one file.

```
GET /api/v1/cameras/:cameraId/credentials
```

- **Auth:** `requireOrgAdmin`
- **Params:** `cameraId` (UUID)
- **Success:** 200 with credential bundle JSON
- **Errors:** 404, 403, 409

### 5.2 Modified: Camera Routes

No route changes needed for create/delete — the service layer handles IoT internally.

---

## 6. Terraform

### 6.1 New Module: `terraform/modules/iot/`

**Resources:**

1. **IAM Role** (`cctv-camera-iot-role`)
   - Trust policy: `credentials.iot.amazonaws.com` can assume
   - Inline policy: KVS permissions scoped to `${credentials-iot:ThingName}/*`
     - `kinesisvideo:DescribeStream`
     - `kinesisvideo:PutMedia`
     - `kinesisvideo:TagStream`
     - `kinesisvideo:GetDataEndpoint`

2. **IoT Role Alias** (`camera-iot-role-alias`)
   - Points to the IAM role above

3. **IoT Policy** (`CameraStreamingPolicy`)
   - `iot:Connect` on the role alias ARN
   - `iot:AssumeRoleWithCertificate` on the role alias ARN

**Variables:**
- `environment` (staging/production)
- `aws_region`
- `aws_account_id`

**Outputs:**
- `iot_role_alias_arn`
- `iot_policy_name`
- `iot_role_arn`

### 6.2 IAM Module Update

Add IoT permissions to the ECS task role:

```
iot:CreateThing
iot:DeleteThing
iot:CreateKeysAndCertificate
iot:UpdateCertificate
iot:DeleteCertificate
iot:AttachPolicy
iot:DetachPolicy
iot:AttachThingPrincipal
iot:DetachThingPrincipal
iot:DescribeEndpoint
```

### 6.3 New Environment Variables

| Variable | Source | Purpose |
|----------|--------|---------|
| `IOT_POLICY_NAME` | Terraform `iot` module output | Policy name to attach to certs |
| `IOT_ROLE_ALIAS` | Terraform `iot` module output | For documentation/credential response |

Added to `src/config/env.ts` Zod schema (optional in test, required in production).

### 6.4 SSM Parameters

Add to `/cctv/staging/`:
- `iot-policy-name` — `CameraStreamingPolicy`
- `iot-role-alias` — `camera-iot-role-alias`

---

## 7. Documentation

### 7.1 Camera Setup Guide: `docs/camera-setup-guide.md`

**Sections:**

1. **Prerequisites** — Raspberry Pi (3B+ or later), IP camera on local network, RTSP URL verified via VLC
2. **Pi Preparation** — install dependencies, clone KVS producer SDK, build with GStreamer plugin (`cmake .. -DBUILD_GSTREAMER_PLUGIN=ON -DBUILD_DEPENDENCIES=ON -DBUILD_SAMPLES=ON && make -j4`)
3. **Register Camera via API** — org admin calls `POST /api/v1/cameras` with name, location, RTSP URL
4. **Download Credentials** — org admin calls `GET /api/v1/cameras/:id/credentials`, saves response fields to files on Pi (`~/certs/device.crt`, `~/certs/private.key`, download root CA from URL)
5. **Configure Environment** — set env vars from credential response (`AWS_DEFAULT_REGION`, `CERT_PATH`, `PRIVATE_KEY_PATH`, `CA_CERT_PATH`, `ROLE_ALIAS`, `IOT_GET_CREDENTIAL_ENDPOINT`)
6. **Disable IPv6** — if on a home/office network without working IPv6 (prevents SDK timeout)
7. **Run the Producer** — `./kvs_gstreamer_sample {streamName} {rtspUrl}`
8. **Verify** — check KVS console media playback, check camera status via API
9. **Multi-Stream Setup** (see 7.2)
10. **Troubleshooting** — IPv6, cert paths, endpoint mismatches, stream name matching

### 7.2 Multi-Stream Section

**Primary approach: one process per camera.** Each camera has its own IoT Thing, certificate, and KVS stream. Run one `kvs_gstreamer_sample` process per camera.

Covers:
- Register multiple cameras via API, download credentials for each
- Shell script example that loops through cameras and starts a producer per camera
- Each process gets its own env vars (cert paths, stream name)
- Fault isolation: one camera crash doesn't affect others
- Resource guide: Pi 3B+ handles 2 streams, Pi 4 (4GB) handles 4-6 streams, mini PC for 8+

**Optimization note:** For 10+ cameras on a single device, mention using `libgstkvssink.so` (GStreamer plugin) in a custom pipeline for reduced memory overhead. Not detailed — just a pointer for advanced users.

### 7.3 Postman Collection Update

Add to the Cameras folder:
- `GET /api/v1/cameras/:cameraId/credentials` — with example response, 409 error case

---

## 8. Testing

### 8.1 Unit Tests: `iot.service.ts`

- `createIoTThing` returns mock Thing ARN in test env
- `deleteIoTThing` with cert (full cleanup path) and without cert (Thing-only delete)
- `issueCredentials` returns mock cert bundle in test env
- `getCredentialEndpoint` returns mock endpoint, caches result

### 8.2 Integration Tests: Credential Endpoint

- 200: successful credential download
- 409: second download attempt returns conflict
- 403: wrong org user cannot download credentials
- 404: non-existent camera
- 401: unauthenticated request
- Auth: only org_admin can access (viewer gets 403)

### 8.3 Updated Camera Tests

- Camera creation stores `iot_thing_name` in DB
- Camera deactivation clears IoT state (or at least doesn't error in test env)
- Cross-org isolation still passes with new fields

### 8.4 Migration Test

- `003_iot_columns.ts` runs cleanly on existing database
- New columns have correct defaults (`credentials_issued = false`, others `NULL`)

---

## 9. File Inventory

| File | Action | Purpose |
|------|--------|---------|
| `src/db/migrations/003_iot_columns.ts` | Create | New DB columns |
| `src/services/iot.service.ts` | Create | IoT SDK wrapper |
| `src/services/camera.service.ts` | Modify | Add IoT Thing create/delete |
| `src/plugins/aws.ts` | Modify | Add IoTClient |
| `src/types/fastify.d.ts` | Modify | Declare `iot` on FastifyInstance |
| `src/config/env.ts` | Modify | Add `IOT_POLICY_NAME`, `IOT_ROLE_ALIAS` |
| `src/routes/cameras/index.ts` | Modify | Add credentials endpoint to existing camera routes |
| `terraform/modules/iot/main.tf` | Create | IAM role, role alias, IoT policy |
| `terraform/modules/iot/variables.tf` | Create | Module variables |
| `terraform/modules/iot/outputs.tf` | Create | Module outputs |
| `terraform/modules/iam/main.tf` | Modify | Add IoT permissions to ECS role |
| `terraform/environments/staging/main.tf` | Modify | Wire up `iot` module |
| `docs/camera-setup-guide.md` | Create | Pi setup documentation |
| `postman/CCTV-Cloud-Storage.postman_collection.json` | Modify | Add credential endpoint |
| `postman/openapi.yml` | Modify | Add credential endpoint schema |
| `tests/cameras/credentials.test.ts` | Create | Credential endpoint tests |
| `tests/cameras/cameras.test.ts` | Modify | Verify IoT fields on create/delete |
