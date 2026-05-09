import { handler } from '../index';

// Mock environment
process.env['INTERNAL_API_URL'] = 'http://localhost:3000';
process.env['SSM_PREFIX'] = '/cctv/test';
process.env['MEDIA_BUCKET'] = 'test-bucket';
process.env['AWS_ACCOUNT_ID'] = '123456789012';

describe('Face Recognition Lambda Handler', () => {
  describe('KVS fragment event', () => {
    it('processes a KVS event and skips when no face detected', async () => {
      const event = {
        Records: [
          {
            kinesis: {
              data: Buffer.from('no-face-frame').toString('base64'),
            },
            eventSourceARN: 'arn:aws:kinesis-video:eu-west-2:123:stream/org123-cam456/1234567890',
          },
        ],
      };

      // In test mode, SearchFacesByImage is not called — handler returns early
      const result = await handler(event);
      expect(result).toEqual({ statusCode: 200, body: 'processed' });
    });
  });

  describe('Purge event', () => {
    it('handles purge_unknowns action', async () => {
      const event = { action: 'purge_unknowns' };
      const result = await handler(event);
      expect(result).toEqual({ statusCode: 200, body: 'purge complete' });
    });
  });
});
