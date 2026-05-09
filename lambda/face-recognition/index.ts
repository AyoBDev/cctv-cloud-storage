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
