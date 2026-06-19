/**
 * migrate-rekognition.ts
 *
 * Re-indexes all face profiles in Rekognition collections for the new AWS account.
 *
 * IMPORTANT: Set AWS_PROFILE before running this script:
 *   AWS_PROFILE=olympusvision npx tsx scripts/migrate-rekognition.ts
 *
 * The AWS SDK v3 automatically reads AWS_PROFILE environment variable to determine
 * which account credentials to use from ~/.aws/credentials
 */

import {
  RekognitionClient,
  CreateCollectionCommand,
  IndexFacesCommand,
} from '@aws-sdk/client-rekognition';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import postgres from 'postgres';

const REGION = 'eu-west-1';
const MEDIA_BUCKET = 'olympusvision-staging-media';
const COLLECTION_PREFIX = 'collection-';

const rekognition = new RekognitionClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

const db = postgres(process.env['DATABASE_URL']!);

interface FaceProfile {
  id: string;
  org_id: string;
  face_id: string | null;
  image_key: string;
}

async function createCollection(orgId: string): Promise<void> {
  const collectionId = `${COLLECTION_PREFIX}${orgId}`;
  try {
    await rekognition.send(new CreateCollectionCommand({ CollectionId: collectionId }));
    console.log(`  Created collection: ${collectionId}`);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ResourceAlreadyExistsException') {
      console.log(`  Collection already exists: ${collectionId}`);
    } else {
      throw err;
    }
  }
}

async function reindexFace(profile: FaceProfile): Promise<string | null> {
  const collectionId = `${COLLECTION_PREFIX}${profile.org_id}`;

  try {
    const result = await rekognition.send(
      new IndexFacesCommand({
        CollectionId: collectionId,
        Image: {
          S3Object: {
            Bucket: MEDIA_BUCKET,
            Name: profile.image_key,
          },
        },
        ExternalImageId: profile.id,
        MaxFaces: 1,
        DetectionAttributes: ['DEFAULT'],
      }),
    );

    const faceRecord = result.FaceRecords?.[0];
    if (!faceRecord?.Face?.FaceId) {
      console.warn(`  WARNING: No face detected for profile ${profile.id}`);
      return null;
    }

    return faceRecord.Face.FaceId;
  } catch (err) {
    console.error(`  ERROR indexing face for profile ${profile.id}:`, err);
    return null;
  }
}

async function main() {
  console.log('=== Rekognition Face Re-indexing Migration ===\n');

  const orgs = await db<{ id: string }[]>`SELECT id FROM organisations`;
  console.log(`Found ${orgs.length} organisations\n`);

  for (const org of orgs) {
    console.log(`Processing org: ${org.id}`);
    await createCollection(org.id);

    const profiles = await db<FaceProfile[]>`
      SELECT id, org_id, face_id, image_key
      FROM face_profiles
      WHERE org_id = ${org.id}
        AND image_key IS NOT NULL
    `;

    console.log(`  ${profiles.length} face profiles to re-index`);

    for (const profile of profiles) {
      const newFaceId = await reindexFace(profile);
      if (newFaceId) {
        await db`
          UPDATE face_profiles
          SET face_id = ${newFaceId}
          WHERE id = ${profile.id}
        `;
        console.log(`  Updated profile ${profile.id}: face_id = ${newFaceId}`);
      }
    }

    console.log('');
  }

  console.log('=== Migration complete ===');
  await db.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
