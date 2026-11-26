import type { Entitlement } from '@aws-sdk/client-marketplace-entitlement-service';
import { nextCustomerStatus, pickCameraEntitlement } from '../../src/services/entitlement.service';

const DIMENSION = 'cameras';
const NOW = new Date('2026-06-01T00:00:00Z');
const NEXT_YEAR = new Date('2027-06-01T00:00:00Z');
const LAST_MONTH = new Date('2026-05-01T00:00:00Z');

function cameraEntitlement(cameras: number, expiresAt?: Date, dimension = DIMENSION): Entitlement {
  return { Dimension: dimension, Value: { IntegerValue: cameras }, ExpirationDate: expiresAt };
}

describe('pickCameraEntitlement', () => {
  it('returns the camera limit and expiry of a valid entitlement', () => {
    expect(pickCameraEntitlement([cameraEntitlement(10, NEXT_YEAR)], DIMENSION, NOW)).toEqual({
      cameraLimit: 10,
      expiresAt: NEXT_YEAR,
    });
  });

  it('returns null when there are no entitlements', () => {
    expect(pickCameraEntitlement([], DIMENSION, NOW)).toBeNull();
  });

  it('ignores expired entitlements', () => {
    expect(pickCameraEntitlement([cameraEntitlement(10, LAST_MONTH)], DIMENSION, NOW)).toBeNull();
  });

  it('ignores other dimensions and zero quantities', () => {
    const entitlements = [cameraEntitlement(10, NEXT_YEAR, 'storage_tb'), cameraEntitlement(0)];
    expect(pickCameraEntitlement(entitlements, DIMENSION, NOW)).toBeNull();
  });

  it('treats an entitlement without an expiry as valid', () => {
    expect(pickCameraEntitlement([cameraEntitlement(5)], DIMENSION, NOW)).toEqual({
      cameraLimit: 5,
      expiresAt: null,
    });
  });

  it('keeps the largest allowance when a renewal overlaps the old contract', () => {
    const entitlements = [cameraEntitlement(10, NEXT_YEAR), cameraEntitlement(25, NEXT_YEAR)];
    expect(pickCameraEntitlement(entitlements, DIMENSION, NOW)?.cameraLimit).toBe(25);
  });
});

describe('nextCustomerStatus', () => {
  const valid = { cameraLimit: 10, expiresAt: NEXT_YEAR };

  it('activates any customer with a valid entitlement', () => {
    expect(nextCustomerStatus('pending_activation', valid)).toBe('active');
    expect(nextCustomerStatus('cancelled', valid)).toBe('active');
  });

  it('keeps a never-activated customer pending when AWS has nothing yet', () => {
    expect(nextCustomerStatus('pending_activation', null)).toBe('pending_activation');
  });

  it('cancels an active customer whose entitlement is gone', () => {
    expect(nextCustomerStatus('active', null)).toBe('cancelled');
  });
});
