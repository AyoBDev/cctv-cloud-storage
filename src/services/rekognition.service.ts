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
  try {
    await client.send(new CreateCollectionCommand({ CollectionId: id }));
  } catch (err: unknown) {
    if (!(err instanceof Error && err.name === 'ResourceAlreadyExistsException')) throw err;
  }
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
