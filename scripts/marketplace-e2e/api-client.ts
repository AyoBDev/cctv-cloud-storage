import type { ReconcileSnapshot, SubscriptionSnapshot } from './checks';

/**
 * The only HTTP calls the check script makes. Everything here is a read,
 * except reconcile, which re-syncs Marketplace customers from AWS.
 */

const REQUEST_TIMEOUT_MS = 15_000;

export class ApiRequestError extends Error {
  constructor(
    public readonly path: string,
    public readonly statusCode: number,
    public readonly errorCode: string | undefined,
    message: string,
  ) {
    super(`${path} returned ${statusCode}${errorCode ? ` ${errorCode}` : ''}: ${message}`);
    this.name = 'ApiRequestError';
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

async function requestJson<T>(baseUrl: string, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(baseUrl + path, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = (body as ErrorBody).error;
    throw new ApiRequestError(path, response.status, error?.code, error?.message ?? text);
  }
  return body as T;
}

export type LoginResult = { kind: 'ok'; accessToken: string } | { kind: 'refused'; code: string };

/** Logs in an org user. A 403 is a result (e.g. cancelled subscription), not a failure. */
export async function login(
  baseUrl: string,
  email: string,
  password: string,
): Promise<LoginResult> {
  try {
    const tokens = await requestJson<{ accessToken: string }>(baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return { kind: 'ok', accessToken: tokens.accessToken };
  } catch (err) {
    if (err instanceof ApiRequestError && err.statusCode === 403 && err.errorCode) {
      return { kind: 'refused', code: err.errorCode };
    }
    throw err;
  }
}

function bearer(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

export async function getSubscription(
  baseUrl: string,
  accessToken: string,
): Promise<SubscriptionSnapshot> {
  return requestJson<SubscriptionSnapshot>(baseUrl, '/api/v1/org/subscription', {
    headers: bearer(accessToken),
  });
}

/** The camera list's pagination total is the org's active camera count. */
export async function countActiveCameras(baseUrl: string, accessToken: string): Promise<number> {
  const page = await requestJson<{ pagination: { total: number } }>(
    baseUrl,
    '/api/v1/cameras?page=1&limit=1',
    { headers: bearer(accessToken) },
  );
  return page.pagination.total;
}

export async function reconcile(
  baseUrl: string,
  internalApiSecret: string,
): Promise<ReconcileSnapshot> {
  return requestJson<ReconcileSnapshot>(baseUrl, '/internal/marketplace/reconcile', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': internalApiSecret },
    body: '{}',
  });
}
