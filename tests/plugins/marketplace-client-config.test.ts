import { marketplaceClientConfig } from '../../src/plugins/aws';

const SELLER_ROLE_ARN = 'arn:aws:iam::111122223333:role/marketplace-api-access';

describe('marketplaceClientConfig', () => {
  it('uses the default credential chain when no seller role is set', () => {
    expect(marketplaceClientConfig('eu-west-1', '')).toEqual({ region: 'eu-west-1' });
  });

  it('assumes the seller role when one is set', () => {
    const config = marketplaceClientConfig('us-east-1', SELLER_ROLE_ARN);

    expect(config.region).toBe('us-east-1');
    expect(typeof config.credentials).toBe('function');
  });
});
