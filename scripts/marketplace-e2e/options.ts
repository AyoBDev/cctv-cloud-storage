import { parseArgs } from 'node:util';

/** Statuses `GET /api/v1/org/subscription` can return (see OrgAccessStatus). */
export const SUBSCRIPTION_STATUSES = [
  'active',
  'pending_activation',
  'cancelled',
  'deactivated',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Env vars the script reads secrets from. Secrets never come from flags or files. */
export const ENV_ORG_ADMIN_EMAIL = 'E2E_ORG_ADMIN_EMAIL';
export const ENV_ORG_ADMIN_PASSWORD = 'E2E_ORG_ADMIN_PASSWORD';
export const ENV_INTERNAL_API_SECRET = 'INTERNAL_API_SECRET';

export interface Expectations {
  status?: SubscriptionStatus;
  cameraLimit?: number;
  /** Only meaningful with --reconcile. */
  reconcileChanged?: number;
}

export interface CheckOptions {
  baseUrl: string;
  email: string;
  password: string;
  reconcile: boolean;
  /** Present only when --reconcile is set. */
  internalApiSecret?: string;
  expectations: Expectations;
}

export type ParseResult =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'options'; options: CheckOptions };

export const USAGE = `Usage: npx tsx scripts/marketplace-e2e-check.ts --base-url <url> [options]

Read-only check of an org's AWS Marketplace subscription on a running API.

Options:
  --base-url <url>             API origin, e.g. https://api.example.com (required)
  --expect-status <status>     Fail unless the subscription status matches
                               (${SUBSCRIPTION_STATUSES.join(' | ')})
  --expect-limit <n>           Fail unless the camera limit equals n
  --reconcile                  Also POST /internal/marketplace/reconcile (re-syncs every
                               Marketplace customer with AWS; the only call that writes)
  --expect-changed <n>         With --reconcile: fail unless "changed" equals n
  -h, --help                   Show this help

Environment:
  ${ENV_ORG_ADMIN_EMAIL}          Org Admin email (required)
  ${ENV_ORG_ADMIN_PASSWORD}       Org Admin password (required)
  ${ENV_INTERNAL_API_SECRET}          Required only with --reconcile

Exit codes: 0 all checks passed, 1 an expectation did not match, 2 usage error,
3 a request failed unexpectedly.`;

type Env = Record<string, string | undefined>;

function parseBaseUrl(raw: string | undefined): string | Error {
  if (!raw) return new Error('--base-url is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return new Error(`--base-url is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return new Error('--base-url must use http or https');
  }
  // Callers append paths such as /api/v1/...; a trailing slash would double up.
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function parseNonNegativeInteger(
  flag: string,
  raw: string | undefined,
): number | undefined | Error {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return new Error(`${flag} must be a whole number, got "${raw}"`);
  return Number(raw);
}

function parseStatus(raw: string | undefined): SubscriptionStatus | undefined | Error {
  if (raw === undefined) return undefined;
  const known = SUBSCRIPTION_STATUSES.find((status) => status === raw);
  if (!known) {
    return new Error(`--expect-status must be one of ${SUBSCRIPTION_STATUSES.join(', ')}`);
  }
  return known;
}

function readFlags(argv: string[]) {
  return parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      'base-url': { type: 'string' },
      'expect-status': { type: 'string' },
      'expect-limit': { type: 'string' },
      'expect-changed': { type: 'string' },
      reconcile: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values;
}

/** Turns argv (without `node script`) and env into validated options. Never throws. */
export function parseCheckOptions(argv: string[], env: Env): ParseResult {
  let flags: ReturnType<typeof readFlags>;
  try {
    flags = readFlags(argv);
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }
  if (flags.help) return { kind: 'help' };

  const baseUrl = parseBaseUrl(flags['base-url']);
  if (baseUrl instanceof Error) return { kind: 'error', message: baseUrl.message };
  const status = parseStatus(flags['expect-status']);
  if (status instanceof Error) return { kind: 'error', message: status.message };
  const cameraLimit = parseNonNegativeInteger('--expect-limit', flags['expect-limit']);
  if (cameraLimit instanceof Error) return { kind: 'error', message: cameraLimit.message };
  const reconcileChanged = parseNonNegativeInteger('--expect-changed', flags['expect-changed']);
  if (reconcileChanged instanceof Error) {
    return { kind: 'error', message: reconcileChanged.message };
  }

  const reconcile = flags.reconcile === true;
  if (reconcileChanged !== undefined && !reconcile) {
    return { kind: 'error', message: '--expect-changed only makes sense with --reconcile' };
  }

  const email = env[ENV_ORG_ADMIN_EMAIL];
  const password = env[ENV_ORG_ADMIN_PASSWORD];
  if (!email || !password) {
    return {
      kind: 'error',
      message: `Set ${ENV_ORG_ADMIN_EMAIL} and ${ENV_ORG_ADMIN_PASSWORD} in the environment`,
    };
  }

  const internalApiSecret = env[ENV_INTERNAL_API_SECRET];
  if (reconcile && !internalApiSecret) {
    return {
      kind: 'error',
      message: `--reconcile needs ${ENV_INTERNAL_API_SECRET} in the environment`,
    };
  }

  // exactOptionalPropertyTypes: only set keys that were actually given.
  const expectations: Expectations = {};
  if (status !== undefined) expectations.status = status;
  if (cameraLimit !== undefined) expectations.cameraLimit = cameraLimit;
  if (reconcileChanged !== undefined) expectations.reconcileChanged = reconcileChanged;

  const options: CheckOptions = {
    baseUrl,
    email,
    password,
    reconcile,
    expectations,
  };
  if (reconcile && internalApiSecret) options.internalApiSecret = internalApiSecret;
  return { kind: 'options', options };
}
