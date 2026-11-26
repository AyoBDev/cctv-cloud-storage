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

    // Enable face detection on the camera
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/cameras/${cameraId}/settings`,
      headers: { authorization: `Bearer ${org.orgAdminAccessToken}` },
      payload: { face_detection_enabled: true },
    });
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
