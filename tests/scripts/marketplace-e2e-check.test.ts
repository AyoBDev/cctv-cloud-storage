import {
  ENV_INTERNAL_API_SECRET,
  ENV_ORG_ADMIN_EMAIL,
  ENV_ORG_ADMIN_PASSWORD,
  parseCheckOptions,
  type CheckOptions,
} from '../../scripts/marketplace-e2e/options';
import {
  describeCameraUsage,
  findMismatches,
  observedStatus,
  type SubscriptionSnapshot,
} from '../../scripts/marketplace-e2e/checks';

const BASE_URL = 'https://api.example.com';
const CREDENTIALS_ENV = {
  [ENV_ORG_ADMIN_EMAIL]: 'jane.doe@example.com',
  [ENV_ORG_ADMIN_PASSWORD]: 'placeholder-password',
};

function parseOk(argv: string[], env: Record<string, string> = CREDENTIALS_ENV): CheckOptions {
  const result = parseCheckOptions(argv, env);
  if (result.kind !== 'options') throw new Error(`expected options, got ${JSON.stringify(result)}`);
  return result.options;
}

function parseError(argv: string[], env: Record<string, string> = CREDENTIALS_ENV): string {
  const result = parseCheckOptions(argv, env);
  if (result.kind !== 'error') throw new Error(`expected error, got ${JSON.stringify(result)}`);
  return result.message;
}

function subscription(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    source: 'aws_marketplace',
    status: 'active',
    cameraLimit: 2,
    expiresAt: '2027-11-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('parseCheckOptions', () => {
  it('reads the base URL and credentials with no expectations by default', () => {
    const options = parseOk(['--base-url', BASE_URL]);
    expect(options).toEqual({
      baseUrl: BASE_URL,
      email: 'jane.doe@example.com',
      password: 'placeholder-password',
      reconcile: false,
      expectations: {},
    });
  });

  it('strips trailing slashes from the base URL', () => {
    expect(parseOk(['--base-url', `${BASE_URL}/`]).baseUrl).toBe(BASE_URL);
    expect(parseOk(['--base-url', `${BASE_URL}/prefix//`]).baseUrl).toBe(`${BASE_URL}/prefix`);
  });

  it('parses --expect-status and --expect-limit', () => {
    const options = parseOk([
      '--base-url',
      BASE_URL,
      '--expect-status',
      'cancelled',
      '--expect-limit',
      '0',
    ]);
    expect(options.expectations).toEqual({ status: 'cancelled', cameraLimit: 0 });
  });

  it('returns help for --help and -h', () => {
    expect(parseCheckOptions(['--help'], {})).toEqual({ kind: 'help' });
    expect(parseCheckOptions(['-h'], {})).toEqual({ kind: 'help' });
  });

  it('requires --base-url', () => {
    expect(parseError([])).toMatch(/--base-url is required/);
  });

  it.each(['not a url', 'ftp://api.example.com'])('rejects base URL %p', (url) => {
    expect(parseError(['--base-url', url])).toMatch(/--base-url/);
  });

  it('rejects an unknown status', () => {
    expect(parseError(['--base-url', BASE_URL, '--expect-status', 'paused'])).toMatch(
      /--expect-status must be one of/,
    );
  });

  it.each(['-1', '2.5', 'two', ''])('rejects --expect-limit %p', (limit) => {
    expect(parseError(['--base-url', BASE_URL, `--expect-limit=${limit}`])).toMatch(
      /--expect-limit must be a whole number/,
    );
  });

  it('rejects unknown flags and positional arguments', () => {
    expect(parseError(['--base-url', BASE_URL, '--delete-everything'])).toMatch(/Unknown option/);
    expect(parseError(['--base-url', BASE_URL, 'extra'])).toMatch(/positional/);
  });

  it('requires both credential env vars', () => {
    const missingPassword = { [ENV_ORG_ADMIN_EMAIL]: 'jane.doe@example.com' };
    expect(parseError(['--base-url', BASE_URL], missingPassword)).toMatch(ENV_ORG_ADMIN_PASSWORD);
    expect(parseError(['--base-url', BASE_URL], {})).toMatch(ENV_ORG_ADMIN_EMAIL);
  });

  it('only reads the internal secret when --reconcile is set', () => {
    const env = { ...CREDENTIALS_ENV, [ENV_INTERNAL_API_SECRET]: 'placeholder-secret' };
    expect(parseOk(['--base-url', BASE_URL], env).internalApiSecret).toBeUndefined();

    const options = parseOk(['--base-url', BASE_URL, '--reconcile', '--expect-changed', '0'], env);
    expect(options.reconcile).toBe(true);
    expect(options.internalApiSecret).toBe('placeholder-secret');
    expect(options.expectations).toEqual({ reconcileChanged: 0 });
  });

  it('requires INTERNAL_API_SECRET for --reconcile', () => {
    expect(parseError(['--base-url', BASE_URL, '--reconcile'])).toMatch(ENV_INTERNAL_API_SECRET);
  });

  it('rejects --expect-changed without --reconcile', () => {
    expect(parseError(['--base-url', BASE_URL, '--expect-changed', '0'])).toMatch(
      /only makes sense with --reconcile/,
    );
  });
});

describe('observedStatus', () => {
  it('uses the subscription status when it was read', () => {
    expect(observedStatus({ subscription: subscription({ status: 'pending_activation' }) })).toBe(
      'pending_activation',
    );
  });

  it('infers the status from a login refusal', () => {
    expect(observedStatus({ loginRefusalCode: 'SUBSCRIPTION_INACTIVE' })).toBe('cancelled');
    expect(observedStatus({ loginRefusalCode: 'FORBIDDEN' })).toBe('deactivated');
    expect(observedStatus({ loginRefusalCode: 'SOMETHING_ELSE' })).toBeUndefined();
  });
});

describe('findMismatches', () => {
  it('passes when there are no expectations', () => {
    expect(findMismatches({ subscription: subscription() }, {})).toEqual([]);
  });

  it('passes when status and limit match', () => {
    expect(
      findMismatches({ subscription: subscription() }, { status: 'active', cameraLimit: 2 }),
    ).toEqual([]);
  });

  it('reports a status mismatch', () => {
    expect(
      findMismatches({ subscription: subscription({ status: 'cancelled' }) }, { status: 'active' }),
    ).toEqual(['status: expected active, got cancelled']);
  });

  it('accepts cancelled when login was refused with SUBSCRIPTION_INACTIVE', () => {
    expect(
      findMismatches({ loginRefusalCode: 'SUBSCRIPTION_INACTIVE' }, { status: 'cancelled' }),
    ).toEqual([]);
  });

  it('reports an unknown status when nothing could be read', () => {
    expect(findMismatches({ loginRefusalCode: 'OTHER' }, { status: 'active' })).toEqual([
      'status: expected active, got unknown',
    ]);
  });

  it('reports a camera limit mismatch, including unlimited and unknown limits', () => {
    expect(findMismatches({ subscription: subscription() }, { cameraLimit: 5 })).toEqual([
      'camera limit: expected 5, got 2',
    ]);
    expect(
      findMismatches({ subscription: subscription({ cameraLimit: null }) }, { cameraLimit: 2 }),
    ).toEqual(['camera limit: expected 2, got unlimited']);
    expect(findMismatches({}, { cameraLimit: 2 })).toEqual([
      'camera limit: expected 2, got unknown',
    ]);
  });

  it('checks reconcile changed when expected', () => {
    const reconcile = { checked: 3, changed: 1, failed: 0 };
    expect(findMismatches({ reconcile }, { reconcileChanged: 1 })).toEqual([]);
    expect(findMismatches({ reconcile }, { reconcileChanged: 0 })).toEqual([
      'reconcile changed: expected 0, got 1',
    ]);
  });

  it('always fails when reconcile could not sync a customer', () => {
    expect(findMismatches({ reconcile: { checked: 2, changed: 0, failed: 1 } }, {})).toEqual([
      'reconcile: 1 customer(s) failed to sync',
    ]);
  });

  it('lists every mismatch, not just the first', () => {
    expect(
      findMismatches(
        { subscription: subscription({ status: 'cancelled', cameraLimit: 0 }) },
        { status: 'active', cameraLimit: 2 },
      ),
    ).toHaveLength(2);
  });
});

describe('describeCameraUsage', () => {
  it('describes usage under, at and over the limit', () => {
    expect(describeCameraUsage(1, 2)).toBe('1 / 2 active');
    expect(describeCameraUsage(2, 2)).toMatch(/at the limit.*CAMERA_LIMIT_REACHED/);
    expect(describeCameraUsage(3, 2)).toMatch(/OVER the limit/);
  });

  it('describes orgs with no limit', () => {
    expect(describeCameraUsage(7, null)).toBe('7 active (no limit)');
  });
});
