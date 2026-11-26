import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { deliverMarketplaceEvents, MARKETPLACE_EVENTS_PATH } from '../sqs-handler';
import { runReconcile, MARKETPLACE_RECONCILE_PATH } from '../reconcile-handler';
import { handler } from '../index';
import type { InternalApiClient } from '../internal-api';

const client: InternalApiClient = {
  baseUrl: 'http://internal.test',
  secret: 'test-secret',
  timeoutMs: 1_000,
};

// Shape of an AWS Marketplace agreement event; IDs are placeholders.
const sampleEvent = {
  version: '0',
  id: 'event-0001',
  'detail-type': 'Purchase Agreement Created - Proposer',
  source: 'aws.agreement-marketplace',
  account: '123456789012',
  time: '2026-01-01T00:00:00Z',
  region: 'us-east-1',
  resources: ['arn:aws:aws-marketplace:us-east-1:123456789012:AWSMarketplace/Agreement/agmt-0001'],
  detail: { agreement: { id: 'agmt-0001' } },
};

function sqsRecord(messageId: string, body: string): SQSRecord {
  return { messageId, body } as SQSRecord;
}

function sqsEvent(...records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

let fetchMock: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  fetchMock = jest.spyOn(globalThis, 'fetch');
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('deliverMarketplaceEvents', () => {
  it('posts the raw event body with the internal secret', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    const body = JSON.stringify(sampleEvent);

    const result = await deliverMarketplaceEvents(sqsEvent(sqsRecord('m1', body)), client);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://internal.test${MARKETPLACE_EVENTS_PATH}`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(body);
    expect((init?.headers as Record<string, string>)['x-internal-secret']).toBe('test-secret');
  });

  it('reports only the failed messages for retry', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error('network down'));
    const body = JSON.stringify(sampleEvent);

    const result = await deliverMarketplaceEvents(
      sqsEvent(sqsRecord('ok', body), sqsRecord('server-error', body), sqsRecord('network', body)),
      client,
    );

    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: 'server-error' },
      { itemIdentifier: 'network' },
    ]);
  });

  it('retries a 4xx so a misconfiguration ends up in the DLQ', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    const result = await deliverMarketplaceEvents(
      sqsEvent(sqsRecord('unauthorised', JSON.stringify(sampleEvent))),
      client,
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'unauthorised' }]);
  });

  it('fails a non-JSON message without calling the API', async () => {
    const result = await deliverMarketplaceEvents(sqsEvent(sqsRecord('bad', 'not json')), client);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('runReconcile', () => {
  it('posts an empty JSON body and returns the counts', async () => {
    const counts = { checked: 3, changed: 1, failed: 0 };
    fetchMock.mockResolvedValue(Response.json(counts));

    const result = await runReconcile(client);

    expect(result).toEqual(counts);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://internal.test${MARKETPLACE_RECONCILE_PATH}`);
    expect(init?.body).toBe('{}');
  });

  it('throws when the API fails so the invocation is marked as an error', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));

    await expect(runReconcile(client)).rejects.toThrow('status 500');
  });
});

describe('handler', () => {
  it('rejects an unrecognised event before doing any work', async () => {
    await expect(handler({ action: 'unknown' } as never)).rejects.toThrow('Unrecognised event');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
