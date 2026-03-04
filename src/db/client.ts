import postgres from 'postgres';
import { env } from '@config/env';

// Shared postgres.js instance for use outside Fastify context (e.g., seed, migrations)
export const sql = postgres(env.DATABASE_URL, {
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
});
