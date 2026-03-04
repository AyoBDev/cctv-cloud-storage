import 'fastify';
import type { Sql } from 'postgres';
import type { Redis } from 'ioredis';

declare module 'fastify' {
  interface FastifyInstance {
    db: Sql;
    redis: Redis;
  }
}
