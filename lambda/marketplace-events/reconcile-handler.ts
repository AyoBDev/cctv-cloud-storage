import { postToInternalApi, type InternalApiClient } from './internal-api.js';

export const MARKETPLACE_RECONCILE_PATH = '/internal/marketplace/reconcile';

export interface ReconcileResult {
  checked: number;
  changed: number;
  failed: number;
}

/**
 * Asks the API to re-read every marketplace customer's entitlements from AWS.
 * This is the safety net for any event that was missed or arrived out of order.
 *
 * Throws on failure so the invocation shows up as an error in Lambda metrics
 * and EventBridge retries it.
 */
export async function runReconcile(client: InternalApiClient): Promise<ReconcileResult> {
  const response = await postToInternalApi(client, MARKETPLACE_RECONCILE_PATH, '{}');
  if (!response.ok) {
    throw new Error(`Marketplace reconcile failed with status ${response.status}`);
  }

  const result = (await response.json()) as ReconcileResult;
  console.log(
    `Marketplace reconcile: checked=${result.checked} changed=${result.changed} failed=${result.failed}`,
  );
  return result;
}
