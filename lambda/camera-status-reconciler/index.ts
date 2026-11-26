import {
  KinesisVideoClient,
  GetDataEndpointCommand,
} from '@aws-sdk/client-kinesis-video';
import {
  KinesisVideoArchivedMediaClient,
  ListFragmentsCommand,
} from '@aws-sdk/client-kinesis-video-archived-media';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const region = process.env['AWS_REGION'] ?? 'eu-west-1';
const internalApiUrl = process.env['INTERNAL_API_URL'] ?? '';
const ssmPrefix = process.env['SSM_PREFIX'] ?? '';
const lookbackSeconds = Number(process.env['RECONCILE_LOOKBACK_SECONDS'] ?? '120');
const isTest = process.env['NODE_ENV'] === 'test';

const kvs = new KinesisVideoClient({ region });
const ssm = new SSMClient({ region });

interface ReconcileCamera {
  kvs_stream_name: string;
}

interface Update {
  kvs_stream_name: string;
  has_media: boolean;
}

let cachedSecret: string | null = null;
async function getInternalSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  if (isTest) {
    cachedSecret = 'test-secret';
    return cachedSecret;
  }
  const result = await ssm.send(
    new GetParameterCommand({
      Name: `${ssmPrefix}/internal-api-secret`,
      WithDecryption: true,
    }),
  );
  cachedSecret = result.Parameter?.Value ?? '';
  return cachedSecret;
}

/**
 * True if the stream received any fragment within the lookback window.
 * A missing stream (ResourceNotFoundException) counts as no media, not an error.
 */
async function streamHasMedia(streamName: string): Promise<boolean> {
  try {
    const ep = await kvs.send(
      new GetDataEndpointCommand({
        StreamName: streamName,
        APIName: 'LIST_FRAGMENTS',
      }),
    );
    if (!ep.DataEndpoint) return false;

    const amc = new KinesisVideoArchivedMediaClient({
      region,
      endpoint: ep.DataEndpoint,
    });
    const now = new Date();
    const res = await amc.send(
      new ListFragmentsCommand({
        StreamName: streamName,
        FragmentSelector: {
          FragmentSelectorType: 'PRODUCER_TIMESTAMP',
          TimestampRange: {
            StartTimestamp: new Date(now.getTime() - lookbackSeconds * 1000),
            EndTimestamp: now,
          },
        },
      }),
    );
    amc.destroy();
    return (res.Fragments?.length ?? 0) > 0;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'ResourceNotFoundException') return false;
    console.error(`ListFragments failed for ${streamName}:`, err);
    return false;
  }
}

export async function handler(): Promise<{ statusCode: number; body: string }> {
  if (isTest) return { statusCode: 200, body: 'reconciled' };

  const secret = await getInternalSecret();

  const listRes = await fetch(`${internalApiUrl}/internal/cameras/reconcile-list`, {
    headers: { 'x-internal-secret': secret },
  });
  if (!listRes.ok) {
    console.error('reconcile-list failed:', listRes.status);
    return { statusCode: 500, body: 'failed to fetch cameras' };
  }
  const { cameras } = (await listRes.json()) as { cameras: ReconcileCamera[] };

  const updates: Update[] = [];
  for (const cam of cameras) {
    updates.push({
      kvs_stream_name: cam.kvs_stream_name,
      has_media: await streamHasMedia(cam.kvs_stream_name),
    });
  }

  const postRes = await fetch(`${internalApiUrl}/internal/cameras/reconcile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': secret,
    },
    body: JSON.stringify({ updates }),
  });
  if (!postRes.ok) {
    console.error('reconcile POST failed:', postRes.status);
    return { statusCode: 500, body: 'failed to post reconcile' };
  }

  return { statusCode: 200, body: `reconciled ${updates.length}` };
}
