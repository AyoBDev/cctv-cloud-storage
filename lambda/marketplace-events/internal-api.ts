/**
 * Minimal client for the API's /internal/* routes.
 *
 * Internal routes are authenticated with a shared secret header rather than a
 * user JWT, matching the other Lambdas in this repo.
 */

export const INTERNAL_SECRET_HEADER = 'x-internal-secret';

export interface InternalApiClient {
  baseUrl: string;
  secret: string;
  /** Per-request timeout so one hung call cannot use up the whole Lambda run. */
  timeoutMs: number;
}

export async function postToInternalApi(
  client: InternalApiClient,
  path: string,
  body: string,
): Promise<Response> {
  return fetch(`${client.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [INTERNAL_SECRET_HEADER]: client.secret,
    },
    body,
    signal: AbortSignal.timeout(client.timeoutMs),
  });
}
