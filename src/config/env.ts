import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  DATABASE_SSL: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),

  REDIS_URL: z.string().url(),

  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  CORS_ORIGIN: z.string().default('http://localhost:3001'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW: z.coerce.number().int().positive().default(60000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  INTERNAL_API_SECRET: z.string().min(16),

  AWS_REGION: z.string().default('us-east-1'),
});

function parseEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Environment validation failed:\n${formatted}`);
  }

  const data = result.data;

  // Replace literal \n sequences in PEM keys with actual newlines
  data.JWT_PRIVATE_KEY = data.JWT_PRIVATE_KEY.replace(/\\n/g, '\n');
  data.JWT_PUBLIC_KEY = data.JWT_PUBLIC_KEY.replace(/\\n/g, '\n');

  return Object.freeze(data);
}

export const env = parseEnv();
export type Env = typeof env;
