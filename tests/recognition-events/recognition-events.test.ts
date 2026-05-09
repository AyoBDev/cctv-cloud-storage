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

    // Seed a recognition event via internal endpoint
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

    if (seedRes.statusCode !== 201) {
      throw new Error(`Failed to seed event: ${seedRes.statusCode} ${seedRes.body}`);
    }
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
