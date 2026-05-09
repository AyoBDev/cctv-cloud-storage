import 'fastify';
import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';
import type { KinesisVideoClient } from '@aws-sdk/client-kinesis-video';
import type { KMSClient } from '@aws-sdk/client-kms';
import type { IoTClient } from '@aws-sdk/client-iot';
import type { RekognitionClient } from '@aws-sdk/client-rekognition';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SESClient } from '@aws-sdk/client-ses';

declare module 'fastify' {
  interface FastifyInstance {
    db: Sql;
    redis: Redis;
    kvs: KinesisVideoClient;
    kms: KMSClient;
    iot: IoTClient;
    rekognition: RekognitionClient;
    s3: S3Client;
    ses: SESClient;
  }
}
