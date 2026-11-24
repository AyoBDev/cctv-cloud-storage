import type { Expectations, SubscriptionStatus } from './options';

/** Body of GET /api/v1/org/subscription. */
export interface SubscriptionSnapshot {
  source: 'aws_marketplace' | 'direct';
  status: SubscriptionStatus;
  /** null means no limit (orgs created by the Super Admin). */
  cameraLimit: number | null;
  expiresAt: string | null;
}

export interface ReconcileSnapshot {
  checked: number;
  changed: number;
  failed: number;
}

/**
 * What the script saw. When login is refused there is no subscription to read,
 * so the status is inferred from the refusal instead.
 */
export interface ObservedState {
  loginRefusalCode?: string;
  subscription?: SubscriptionSnapshot;
  activeCameras?: number;
  reconcile?: ReconcileSnapshot;
}

/**
 * Login refusals that tell us the subscription status (see signInDenial in
 * entitlement.service.ts). A cancelled org cannot sign in at all, so this is
 * the only way to confirm "cancelled" from outside.
 */
const STATUS_BY_LOGIN_REFUSAL: Record<string, SubscriptionStatus> = {
  SUBSCRIPTION_INACTIVE: 'cancelled',
  FORBIDDEN: 'deactivated',
};

export function statusFromLoginRefusal(code: string): SubscriptionStatus | undefined {
  return STATUS_BY_LOGIN_REFUSAL[code];
}

export function observedStatus(observed: ObservedState): SubscriptionStatus | undefined {
  if (observed.subscription) return observed.subscription.status;
  if (observed.loginRefusalCode) return statusFromLoginRefusal(observed.loginRefusalCode);
  return undefined;
}

function formatLimit(limit: number | null | undefined): string {
  if (limit === undefined) return 'unknown';
  return limit === null ? 'unlimited' : String(limit);
}

/** Every expectation that did not hold, as a human-readable line. Empty means pass. */
export function findMismatches(observed: ObservedState, expected: Expectations): string[] {
  const mismatches: string[] = [];

  if (expected.status !== undefined) {
    const actual = observedStatus(observed);
    if (actual !== expected.status) {
      mismatches.push(`status: expected ${expected.status}, got ${actual ?? 'unknown'}`);
    }
  }

  if (expected.cameraLimit !== undefined) {
    const actual = observed.subscription?.cameraLimit;
    if (actual !== expected.cameraLimit) {
      mismatches.push(`camera limit: expected ${expected.cameraLimit}, got ${formatLimit(actual)}`);
    }
  }

  if (observed.reconcile && observed.reconcile.failed > 0) {
    mismatches.push(`reconcile: ${observed.reconcile.failed} customer(s) failed to sync`);
  }

  if (expected.reconcileChanged !== undefined) {
    const actual = observed.reconcile?.changed;
    if (actual !== expected.reconcileChanged) {
      mismatches.push(
        `reconcile changed: expected ${expected.reconcileChanged}, got ${actual ?? 'unknown'}`,
      );
    }
  }

  return mismatches;
}

/**
 * A one-line summary of camera usage. Being over the limit is allowed (a
 * downgrade keeps existing cameras running), so this is a warning, not a failure.
 */
export function describeCameraUsage(activeCameras: number, cameraLimit: number | null): string {
  if (cameraLimit === null) return `${activeCameras} active (no limit)`;
  if (activeCameras > cameraLimit) {
    return `${activeCameras} / ${cameraLimit} active (OVER the limit: new cameras will be refused)`;
  }
  if (activeCameras === cameraLimit) {
    return `${activeCameras} / ${cameraLimit} active (at the limit: the next camera gets CAMERA_LIMIT_REACHED)`;
  }
  return `${activeCameras} / ${cameraLimit} active`;
}
