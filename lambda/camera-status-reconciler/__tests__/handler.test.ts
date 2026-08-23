import { handler } from '../index';

process.env['NODE_ENV'] = 'test';
process.env['INTERNAL_API_URL'] = 'https://api.example.com';
process.env['SSM_PREFIX'] = '/cctv/test';

describe('Camera Status Reconciler Lambda', () => {
  it('returns success in test mode', async () => {
    const result = await handler();
    expect(result).toEqual({ statusCode: 200, body: 'reconciled' });
  });
});
