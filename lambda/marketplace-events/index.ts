import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { InternalApiClient } from './internal-api.js';
import { deliverMarketplaceEvents } from './sqs-handler.js';
import { runReconcile, type ReconcileResult } from './reconcile-handler.js';

/** Must stay well under the Lambda timeout set in terraform/modules/marketplace. */
const INTERNAL_API_TIMEOUT_MS = 10_000;

/** Input the hourly EventBridge schedule sends (see terraform/modules/marketplace). */
export const RECONCILE_ACTION = 'reconcile';

interface ReconcileTrigger {
  action: typeof RECONCILE_ACTION;
}

export type MarketplaceLambdaEvent = SQSEvent | ReconcileTrigger;

const internalApiUrl = process.env['INTERNAL_API_URL'] ?? '';
const ssmPrefix = process.env['SSM_PREFIX'] ?? '';

// Region comes from the Lambda runtime's AWS_REGION.
const ssm = new SSMClient({});

let cachedInternalSecret: string | null = null;

async function getInternalSecret(): Promise<string> {
  if (cachedInternalSecret) return cachedInternalSecret;

  const result = await ssm.send(
    new GetParameterCommand({
      Name: `${ssmPrefix}/internal-api-secret`,
      WithDecryption: true,
    }),
  );

  cachedInternalSecret = result.Parameter?.Value ?? '';
  return cachedInternalSecret;
}

async function buildClient(): Promise<InternalApiClient> {
  return {
    baseUrl: internalApiUrl,
    secret: await getInternalSecret(),
    timeoutMs: INTERNAL_API_TIMEOUT_MS,
  };
}

function isSqsEvent(event: MarketplaceLambdaEvent): event is SQSEvent {
  return 'Records' in event && Array.isArray(event.Records);
}

/**
 * One function, two triggers: the SQS event source mapping (marketplace events)
 * and the hourly schedule (reconcile).
 */
export async function handler(
  event: MarketplaceLambdaEvent,
): Promise<SQSBatchResponse | ReconcileResult> {
  // Reject unknown input before touching SSM.
  if (!isSqsEvent(event) && event.action !== RECONCILE_ACTION) {
    throw new Error(`Unrecognised event: ${JSON.stringify(event)}`);
  }

  const client = await buildClient();
  if (isSqsEvent(event)) return deliverMarketplaceEvents(event, client);
  return runReconcile(client);
}
