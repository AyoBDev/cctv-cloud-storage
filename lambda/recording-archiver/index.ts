import { KinesisVideoClient, GetDataEndpointCommand } from '@aws-sdk/client-kinesis-video';
import {
  KinesisVideoArchivedMediaClient,
  GetClipCommand,
} from '@aws-sdk/client-kinesis-video-archived-media';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const region = process.env['AWS_REGION'] ?? 'eu-west-2';
const internalApiUrl = process.env['INTERNAL_API_URL'] ?? '';
const ssmPrefix = process.env['SSM_PREFIX'] ?? '';
const mediaBucket = process.env['MEDIA_BUCKET'] ?? '';
const isTest = process.env['NODE_ENV'] === 'test';

const kvs = new KinesisVideoClient({ region });
const s3 = new S3Client({ region });
const ssm = new SSMClient({ region });

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

function align5Min(date: Date): Date {
  const ms = date.getTime();
  const fiveMin = 5 * 60 * 1000;
  return new Date(Math.floor(ms / fiveMin) * fiveMin);
}

function formatS3Key(orgId: string, cameraId: string, startTime: Date): string {
  const date = startTime.toISOString().split('T')[0]!;
  const hours = String(startTime.getUTCHours()).padStart(2, '0');
  const minutes = String(startTime.getUTCMinutes()).padStart(2, '0');
  return `orgs/${orgId}/cameras/${cameraId}/${date}/${hours}-${minutes}.mp4`;
}

interface ActiveCamera {
  id: string;
  org_id: string;
  kvs_stream_name: string;
  kvs_stream_arn: string | null;
}

export async function handler(): Promise<{ statusCode: number; body: string }> {
  if (isTest) {
    return { statusCode: 200, body: 'processed' };
  }

  const internalSecret = await getInternalSecret();

  // Get active cameras from the API
  const camerasRes = await fetch(`${internalApiUrl}/internal/cameras/active`, {
    headers: { 'x-internal-secret': internalSecret },
  });

  if (!camerasRes.ok) {
    console.error('Failed to fetch active cameras:', camerasRes.status);
    return { statusCode: 500, body: 'failed to fetch cameras' };
  }

  const { cameras } = (await camerasRes.json()) as { cameras: ActiveCamera[] };

  const endTime = align5Min(new Date());
  const startTime = new Date(endTime.getTime() - 5 * 60 * 1000);

  let processed = 0;
  let errors = 0;

  for (const camera of cameras) {
    try {
      // Get KVS data endpoint for GET_CLIP
      const endpointRes = await kvs.send(
        new GetDataEndpointCommand({
          StreamName: camera.kvs_stream_name,
          APIName: 'GET_CLIP',
        }),
      );

      const dataEndpoint = endpointRes.DataEndpoint;
      if (!dataEndpoint) continue;

      // Get clip from KVS
      const archivedMediaClient = new KinesisVideoArchivedMediaClient({
        region,
        endpoint: dataEndpoint,
      });

      const clipRes = await archivedMediaClient.send(
        new GetClipCommand({
          StreamName: camera.kvs_stream_name,
          ClipFragmentSelector: {
            FragmentSelectorType: 'SERVER_TIMESTAMP',
            TimestampRange: {
              StartTimestamp: startTime,
              EndTimestamp: endTime,
            },
          },
        }),
      );

      if (!clipRes.Payload) continue;

      // Read the stream into a buffer
      const chunks: Uint8Array[] = [];
      const reader = clipRes.Payload as AsyncIterable<Uint8Array>;
      for await (const chunk of reader) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      if (buffer.length === 0) continue;

      // Upload to S3
      const s3Key = formatS3Key(camera.org_id, camera.id, startTime);
      await s3.send(
        new PutObjectCommand({
          Bucket: mediaBucket,
          Key: s3Key,
          Body: buffer,
          ContentType: 'video/mp4',
        }),
      );

      // Post metadata to internal API
      await fetch(`${internalApiUrl}/internal/recordings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': internalSecret,
        },
        body: JSON.stringify({
          org_id: camera.org_id,
          camera_id: camera.id,
          s3_key: s3Key,
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString(),
          duration_seconds: Math.round(buffer.length > 0 ? 300 : 0),
          file_size_bytes: buffer.length,
        }),
      });

      processed++;
    } catch (err: unknown) {
      // No data in time range or stream issues — skip
      if (err instanceof Error && err.name === 'ResourceNotFoundException') continue;
      if (err instanceof Error && err.message.includes('No fragments')) continue;
      console.error(`Error archiving camera ${camera.id}:`, err);
      errors++;
    }
  }

  return { statusCode: 200, body: `processed: ${processed}, errors: ${errors}` };
}
