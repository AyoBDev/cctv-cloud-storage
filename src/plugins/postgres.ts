import fp from 'fastify-plugin';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { env } from '@config/env';

export default fp(async function postgresPlugin(app: FastifyInstance) {
  const sql = postgres(env.DATABASE_URL, {
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: (notice) => app.log.warn({ notice }, 'PostgreSQL notice'),
  });

  // Test connection
  try {
    await sql`SELECT 1`;
  } catch (err) {
    app.log.fatal({ err }, 'Failed to connect to PostgreSQL');
    throw err;
  }

  app.decorate('db', sql);

  app.addHook('onClose', async () => {
    await sql.end();
  });
});
