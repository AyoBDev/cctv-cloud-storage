import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { S3Client } from '@aws-sdk/client-s3';
import { env } from '@config/env';

const isTestEnv = () => env.NODE_ENV === 'test';

let s3Client: S3Client | null = null;

export function setS3Client(client: S3Client): void {
  s3Client = client;
}

function getClient(): S3Client {
  if (!s3Client) throw new Error('S3Client not initialized');
  return s3Client;
}

function extensionFromMime(mime: string): string {
  if (mime === 'image/png') return 'png';
  return 'jpg';
}

export async function uploadFaceImage(
  orgId: string,
  profileId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  const ext = extensionFromMime(mimeType);
  const key = `orgs/${orgId}/face-profiles/${profileId}/original.${ext}`;

  if (isTestEnv()) return key;

  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: env.S3_MEDIA_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    }),
  );

  return key;
}

export async function uploadEventThumbnail(
  orgId: string,
  eventId: string,
  buffer: Buffer,
): Promise<string> {
  const key = `recognition-events/${orgId}/${eventId}/thumb.jpg`;

  if (isTestEnv()) return key;

  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: env.S3_MEDIA_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'image/jpeg',
    }),
  );

  return key;
}

export async function getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
  if (isTestEnv()) return `https://mock-s3.amazonaws.com/${key}?expires=${ttlSeconds}`;

  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: env.S3_MEDIA_BUCKET,
    Key: key,
  });

  return awsGetSignedUrl(client, command, { expiresIn: ttlSeconds });
}

export async function deleteObject(key: string): Promise<void> {
  if (isTestEnv()) return;

  const client = getClient();
  await client.send(
    new DeleteObjectCommand({
      Bucket: env.S3_MEDIA_BUCKET,
      Key: key,
    }),
  );
}
