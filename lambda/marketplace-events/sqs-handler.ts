import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { postToInternalApi, type InternalApiClient } from './internal-api.js';

export const MARKETPLACE_EVENTS_PATH = '/internal/marketplace/events';

/**
 * Forwards each AWS Marketplace EventBridge event (one per SQS message) to the
 * API unchanged. The API stores events idempotently, so redelivery is safe.
 *
 * Returns SQS partial-batch failures so that only the messages that failed are
 * retried; after the queue's maxReceiveCount they land in the DLQ.
 */
export async function deliverMarketplaceEvents(
  event: SQSEvent,
  client: InternalApiClient,
): Promise<SQSBatchResponse> {
  const outcomes = await Promise.all(
    event.Records.map(async (record) => ({
      messageId: record.messageId,
      delivered: await deliverRecord(record, client),
    })),
  );

  const batchItemFailures = outcomes
    .filter((outcome) => !outcome.delivered)
    .map((outcome) => ({ itemIdentifier: outcome.messageId }));

  console.log(
    `Marketplace events: ${outcomes.length - batchItemFailures.length} delivered, ${batchItemFailures.length} failed`,
  );
  return { batchItemFailures };
}

async function deliverRecord(record: SQSRecord, client: InternalApiClient): Promise<boolean> {
  const eventJson = parseEventBody(record);
  if (eventJson === null) return false;

  try {
    const response = await postToInternalApi(client, MARKETPLACE_EVENTS_PATH, eventJson);
    if (response.ok) return true;

    // Any non-2xx is retried: 5xx is the API asking for a retry, and a 4xx
    // (e.g. a wrong secret) should end up in the DLQ where it gets noticed.
    console.error(`Marketplace event ${record.messageId} rejected with status ${response.status}`);
    return false;
  } catch (err) {
    console.error(`Marketplace event ${record.messageId} delivery failed:`, err);
    return false;
  }
}

/**
 * The message body is the EventBridge event exactly as the rule delivered it.
 * We validate that it is JSON but send the original text so the API receives
 * the event byte-for-byte.
 */
function parseEventBody(record: SQSRecord): string | null {
  try {
    JSON.parse(record.body);
    return record.body;
  } catch {
    console.error(`Marketplace event ${record.messageId} has a non-JSON body`);
    return null;
  }
}
