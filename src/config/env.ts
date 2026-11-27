import 'dotenv/config';
import { z } from 'zod';

/**
 * How the AWS Marketplace listing is priced. AWS does not let a product change its
 * pricing model, so this is fixed per product code.
 * - `contract`: buyers buy a number of cameras; AWS reports it as an entitlement.
 * - `free`: buyers pay nothing and AWS reports no entitlements, only the agreement.
 */
export const MARKETPLACE_PRICING_MODELS = ['contract', 'free'] as const;
export type MarketplacePricingModel = (typeof MARKETPLACE_PRICING_MODELS)[number];

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

  // Grace window (seconds) before a camera with no recent KVS media is demoted
  // from 'online' to 'offline' by the status reconciler.
  RECONCILE_GRACE_SECONDS: z.coerce.number().int().positive().default(600),

  AWS_REGION: z.string().default('eu-west-1'),
  KMS_KEY_ID: z.string().default(''),
  IOT_POLICY_NAME: z.string().default(''),
  IOT_ROLE_ALIAS: z.string().default('camera-iot-role-alias'),
  IOT_THING_TYPE: z.string().default('IPCamera'),

  S3_MEDIA_BUCKET: z.string().default(''),
  SES_FROM_EMAIL: z.string().email().default('noreply@example.com'),
  SES_REGION: z.string().default('eu-west-1'),
  REKOGNITION_COLLECTION_PREFIX: z.string().default('collection-'),
  REKOGNITION_UNKNOWN_PREFIX: z.string().default('unknown-'),
  REKOGNITION_MATCH_THRESHOLD: z.coerce.number().min(0).max(100).default(80),
  UNKNOWN_FACE_TTL_HOURS: z.coerce.number().int().positive().default(24),
  ALERT_DEBOUNCE_SECONDS: z.coerce.number().int().positive().default(300),

  SNS_PLATFORM_ARN_IOS: z.string().default(''),
  SNS_PLATFORM_ARN_ANDROID: z.string().default(''),
  WEB_PUSH_VAPID_PUBLIC_KEY: z.string().default(''),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.string().default(''),
  WEB_PUSH_CONTACT_EMAIL: z.string().default(''),

  // AWS Marketplace (SaaS). ResolveCustomer runs in AWS_REGION; the Entitlement
  // and Agreement services are called in MARKETPLACE_ENTITLEMENT_REGION.
  MARKETPLACE_PRODUCT_CODE: z.string().default(''),
  // Must match the listing's pricing model. `free` listings give every buyer
  // MARKETPLACE_FREE_CAMERA_LIMIT cameras while their agreement is active.
  MARKETPLACE_PRICING_MODEL: z.enum(MARKETPLACE_PRICING_MODELS).default('contract'),
  MARKETPLACE_FREE_CAMERA_LIMIT: z.coerce.number().int().positive().default(5),
  MARKETPLACE_CAMERA_DIMENSION: z.string().default('cameras'),
  MARKETPLACE_ENTITLEMENT_REGION: z.string().default('us-east-1'),
  MARKETPLACE_REGISTRATION_PAGE_URL: z
    .string()
    .url()
    .default('https://www.olympusvisions.com/marketplace/register'),
  MARKETPLACE_REGISTRATION_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  // AWS only answers ResolveCustomer/GetEntitlements for the account that published
  // the listing. When that seller account is not the one the API runs in, set this to
  // a role in the seller account; empty means "use the task role directly".
  MARKETPLACE_SELLER_ROLE_ARN: z
    .string()
    .regex(/^(arn:aws[a-z-]*:iam::\d{12}:role\/.+)?$/, 'Must be an IAM role ARN or empty')
    .default(''),
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
