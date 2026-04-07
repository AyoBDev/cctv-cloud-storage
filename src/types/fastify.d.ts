import 'fastify';
import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';
import type { KinesisVideoClient } from '@aws-sdk/client-kinesis-video';
import type { KMSClient } from '@aws-sdk/client-kms';
import type { IoTClient } from '@aws-sdk/client-iot';

declare module 'fastify' {
  interface FastifyInstance {
    db: Sql;
    redis: Redis;
    kvs: KinesisVideoClient;
    kms: KMSClient;
    iot: IoTClient;
  }
}
