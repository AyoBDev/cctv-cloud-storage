import { handler } from '../index';

process.env['NODE_ENV'] = 'test';
process.env['INTERNAL_API_URL'] = 'http://localhost:3000';
process.env['SSM_PREFIX'] = '/cctv/test';
process.env['MEDIA_BUCKET'] = 'test-bucket';

describe('Recording Archiver Lambda Handler', () => {
  it('returns success in test mode', async () => {
    const result = await handler();
    expect(result).toEqual({ statusCode: 200, body: 'processed' });
  });
});
