import postgres from 'postgres';
import { Redis } from 'ioredis';
import { getReconcilableCameras, reconcileCameraStatuses } from '@services/camera.service';

const db = postgres(process.env['DATABASE_URL']!);
const redis = new Redis(process.env['REDIS_URL']!);

afterAll(async () => {
  await db.end();
  redis.disconnect();
});

// Create an active camera row directly and return its (unique) stream name.
// lastSeenSql is raw SQL for the last_seen_at value, e.g. "NULL" or
// "now() - interval '60 seconds'".
async function makeCamera(status: string, lastSeenSql: string): Promise<string> {
  const name = `recon-${Math.random().toString(36).slice(2, 10)}`;
  const orgRows = await db<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`;
  const orgId = orgRows[0]!.id;
  await db`
    INSERT INTO cameras (org_id, name, slug, kvs_stream_name, status, is_active, last_seen_at)
    VALUES (
      ${orgId}, ${name}, ${name}, ${name},
      ${status}::camera_status, true, ${db.unsafe(lastSeenSql)}
    )
  `;
  return name;
}

describe('getReconcilableCameras', () => {
  it('returns stream names for active non-inactive cameras', async () => {
    const online = await makeCamera('online', 'now()');
    const rows = await getReconcilableCameras(db);
    expect(Array.isArray(rows)).toBe(true);
    for (const r of rows) {
      expect(typeof r.kvs_stream_name).toBe('string');
    }
    expect(rows.some((r) => r.kvs_stream_name === online)).toBe(true);
  });

  it('excludes inactive cameras', async () => {
    const inactive = await makeCamera('inactive', 'NULL');
    const rows = await getReconcilableCameras(db);
    expect(rows.some((r) => r.kvs_stream_name === inactive)).toBe(false);
  });
});

describe('reconcileCameraStatuses', () => {
  it('promotes provisioning -> online when media present', async () => {
    const s = await makeCamera('provisioning', 'NULL');
    const res = await reconcileCameraStatuses(
      db,
      redis,
      [{ kvs_stream_name: s, has_media: true }],
      600,
    );
    expect(res.find((r) => r.kvs_stream_name === s)).toEqual({
      kvs_stream_name: s,
      status: 'online',
      changed: true,
    });
  });

  it('keeps online when no media but within grace', async () => {
    const s = await makeCamera('online', "now() - interval '60 seconds'");
    const res = await reconcileCameraStatuses(
      db,
      redis,
      [{ kvs_stream_name: s, has_media: false }],
      600,
    );
    expect(res.find((r) => r.kvs_stream_name === s)).toMatchObject({
      status: 'online',
      changed: false,
    });
  });

  it('demotes online -> offline when stale past grace', async () => {
    const s = await makeCamera('online', "now() - interval '3600 seconds'");
    const res = await reconcileCameraStatuses(
      db,
      redis,
      [{ kvs_stream_name: s, has_media: false }],
      600,
    );
    expect(res.find((r) => r.kvs_stream_name === s)).toMatchObject({
      status: 'offline',
      changed: true,
    });
  });

  it('never demotes provisioning on no media', async () => {
    const s = await makeCamera('provisioning', 'NULL');
    const res = await reconcileCameraStatuses(
      db,
      redis,
      [{ kvs_stream_name: s, has_media: false }],
      600,
    );
    expect(res.find((r) => r.kvs_stream_name === s)).toMatchObject({
      status: 'provisioning',
      changed: false,
    });
  });

  it('is idempotent on repeated online', async () => {
    const s = await makeCamera('online', 'now()');
    const res = await reconcileCameraStatuses(
      db,
      redis,
      [{ kvs_stream_name: s, has_media: true }],
      600,
    );
    expect(res.find((r) => r.kvs_stream_name === s)).toMatchObject({
      status: 'online',
      changed: false,
    });
  });

  it('skips unknown stream names', async () => {
    const res = await reconcileCameraStatuses(
      db,
      redis,
      [{ kvs_stream_name: 'nope-xyz-unknown', has_media: true }],
      600,
    );
    expect(res.find((r) => r.kvs_stream_name === 'nope-xyz-unknown')).toBeUndefined();
  });
});
