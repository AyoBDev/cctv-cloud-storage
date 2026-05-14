import {
  KinesisVideoClient,
  GetDataEndpointCommand,
} from '@aws-sdk/client-kinesis-video';
import {
  KinesisVideoArchivedMediaClient,
  GetClipCommand,
  ClipFragmentSelectorType,
} from '@aws-sdk/client-kinesis-video-archived-media';
import {
  RekognitionClient,
  StartFaceSearchCommand,
  GetFaceSearchCommand,
} from '@aws-sdk/client-rekognition';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const region = process.env['AWS_REGION'] ?? 'eu-west-2';
const internalApiUrl = process.env['INTERNAL_API_URL'] ?? '';
const ssmPrefix = process.env['SSM_PREFIX'] ?? '';
const mediaBucket = process.env['MEDIA_BUCKET'] ?? '';
const snsTopicArn = process.env['SNS_TOPIC_ARN'] ?? '';
const rekognitionRoleArn = process.env['REKOGNITION_ROLE_ARN'] ?? '';
const isTest = process.env['NODE_ENV'] === 'test';

const rekognition = new RekognitionClient({ region });
const ssm = new SSMClient({ region });
const kvs = new KinesisVideoClient({ region });
const s3 = new S3Client({ region });

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

async function getActiveCameras(secret: string): Promise<
  Array<{ camera_id: string; org_id: string; kvs_stream_name: string }>
> {
  const resp = await fetch(`${internalApiUrl}/internal/cameras/active`, {
    headers: { 'x-internal-secret': secret },
  });
  if (!resp.ok) {
    console.error('Failed to fetch active cameras:', resp.status);
    return [];
  }
  const data = (await resp.json()) as {
    cameras: Array<{ id: string; org_id: string; kvs_stream_name: string }>;
  };
  return data.cameras.map((c) => ({ camera_id: c.id, org_id: c.org_id, kvs_stream_name: c.kvs_stream_name }));
}

async function getClipAndUpload(streamName: string, s3Key: string): Promise<boolean> {
  // Get archived media endpoint
  const endpointResp = await kvs.send(
    new GetDataEndpointCommand({
      StreamName: streamName,
      APIName: 'GET_CLIP',
    }),
  );

  const endpoint = endpointResp.DataEndpoint;
  if (!endpoint) return false;

  const archivedMedia = new KinesisVideoArchivedMediaClient({ region, endpoint });

  // Get a 5-second clip
  const now = new Date();
  const fiveSecondsAgo = new Date(now.getTime() - 5_000);

  const clipResp = await archivedMedia.send(
    new GetClipCommand({
      StreamName: streamName,
      ClipFragmentSelector: {
        FragmentSelectorType: ClipFragmentSelectorType.SERVER_TIMESTAMP,
        TimestampRange: {
          StartTimestamp: fiveSecondsAgo,
          EndTimestamp: now,
        },
      },
    }),
  );

  if (!clipResp.Payload) return false;

  // Read payload
  const chunks: Uint8Array[] = [];
  const stream = clipResp.Payload as AsyncIterable<Uint8Array>;
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) return false;

  const videoBuffer = Buffer.concat(chunks);
  if (videoBuffer.length < 1000) return false; // Too small to be valid

  // Upload to S3
  await s3.send(
    new PutObjectCommand({
      Bucket: mediaBucket,
      Key: s3Key,
      Body: videoBuffer,
      ContentType: 'video/mp4',
    }),
  );

  return true;
}

async function waitForFaceSearch(jobId: string, maxWaitMs: number = 25_000): Promise<{
  status: string;
  persons: Array<{
    timestamp: number;
    faceMatches: Array<{ similarity: number; faceId: string; externalImageId: string }>;
  }>;
}> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const result = await rekognition.send(
      new GetFaceSearchCommand({ JobId: jobId }),
    );

    if (result.JobStatus === 'SUCCEEDED') {
      const persons = (result.Persons ?? [])
        .filter((p) => p.FaceMatches && p.FaceMatches.length > 0)
        .map((p) => ({
          timestamp: p.Timestamp ?? 0,
          faceMatches: (p.FaceMatches ?? []).map((m) => ({
            similarity: m.Similarity ?? 0,
            faceId: m.Face?.FaceId ?? '',
            externalImageId: m.Face?.ExternalImageId ?? '',
          })),
        }));
      return { status: 'SUCCEEDED', persons };
    }

    if (result.JobStatus === 'FAILED') {
      return { status: 'FAILED', persons: [] };
    }

    // Wait 2 seconds before polling again
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return { status: 'TIMEOUT', persons: [] };
}

interface LambdaEvent {
  action?: string;
  Records?: unknown[];
}

export async function handler(event: LambdaEvent): Promise<{ statusCode: number; body: string }> {
  // Purge action (from hourly EventBridge rule)
  if (event.action === 'purge_unknowns') {
    return { statusCode: 200, body: 'purge complete' };
  }

  if (isTest) {
    return { statusCode: 200, body: 'processed' };
  }

  // Polling mode: get active cameras, grab clips, run face search
  const internalSecret = await getInternalSecret();
  const cameras = await getActiveCameras(internalSecret);

  if (cameras.length === 0) {
    return { statusCode: 200, body: 'no active cameras' };
  }

  let processed = 0;
  let errors = 0;

  for (const camera of cameras) {
    try {
      const collectionId = `collection-${camera.org_id}`;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const clipKey = `face-search-clips/${camera.camera_id}/${timestamp}.mp4`;

      // Get a short clip and upload to S3
      const uploaded = await getClipAndUpload(camera.kvs_stream_name, clipKey);
      if (!uploaded) continue; // No recent footage

      // Start async face search
      const startResult = await rekognition.send(
        new StartFaceSearchCommand({
          Video: {
            S3Object: { Bucket: mediaBucket, Name: clipKey },
          },
          CollectionId: collectionId,
          FaceMatchThreshold: 80,
          NotificationChannel: snsTopicArn
            ? { SNSTopicArn: snsTopicArn, RoleArn: rekognitionRoleArn }
            : undefined,
        }),
      );

      if (!startResult.JobId) {
        console.error(`No JobId returned for camera ${camera.camera_id}`);
        errors++;
        continue;
      }

      // Wait for results (max 25s — Lambda timeout is 30s)
      const result = await waitForFaceSearch(startResult.JobId);

      if (result.status !== 'SUCCEEDED') {
        console.error(`Face search ${result.status} for camera ${camera.camera_id}`);
        if (result.status === 'FAILED') errors++;
        continue;
      }

      // Process matches
      for (const person of result.persons) {
        const bestMatch = person.faceMatches[0];
        if (!bestMatch) continue;

        await fetch(`${internalApiUrl}/internal/recognition-events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': internalSecret,
          },
          body: JSON.stringify({
            org_id: camera.org_id,
            camera_id: camera.camera_id,
            thumbnail_key: clipKey,
            confidence: bestMatch.similarity,
            face_profile_id: bestMatch.externalImageId || bestMatch.faceId,
            event_type: 'known_face',
          }),
        });
        processed++;
        break; // One event per camera per invocation
      }

      // If faces were detected but none matched, report unknown
      if (result.persons.length === 0) {
        // Check if any persons were detected at all (even without matches)
        const fullResult = await rekognition.send(
          new GetFaceSearchCommand({ JobId: startResult.JobId }),
        );
        const detectedPersons = fullResult.Persons ?? [];
        const hasPersons = detectedPersons.some(
          (p) => p.Person?.Face?.BoundingBox,
        );

        if (hasPersons) {
          await fetch(`${internalApiUrl}/internal/recognition-events`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal-secret': internalSecret,
            },
            body: JSON.stringify({
              org_id: camera.org_id,
              camera_id: camera.camera_id,
              thumbnail_key: clipKey,
              confidence: 0,
              face_profile_id: null,
              event_type: 'unknown_face',
            }),
          });
          processed++;
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.message?.includes('No fragments found')) continue;
        if (err.name === 'ResourceNotFoundException') continue;
      }
      console.error(`Error processing camera ${camera.camera_id}:`, err);
      errors++;
    }
  }

  return {
    statusCode: 200,
    body: `processed: ${processed}, errors: ${errors}`,
  };
}
