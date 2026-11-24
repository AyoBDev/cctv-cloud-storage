/**
 * Read-only check of an org's AWS Marketplace subscription on a running API,
 * used by each step of the end-to-end runbook (marketplace/E2E-RUNBOOK.md).
 *
 *   E2E_ORG_ADMIN_EMAIL=... E2E_ORG_ADMIN_PASSWORD=... \
 *     npx tsx scripts/marketplace-e2e-check.ts --base-url https://api.example.com \
 *     --expect-status active --expect-limit 2
 *
 * It never creates, changes or deletes anything, except the optional --reconcile,
 * which asks the API to re-sync every Marketplace customer with AWS.
 */
import {
  ApiRequestError,
  countActiveCameras,
  getSubscription,
  login,
  reconcile,
} from './marketplace-e2e/api-client';
import {
  describeCameraUsage,
  findMismatches,
  statusFromLoginRefusal,
  type ObservedState,
} from './marketplace-e2e/checks';
import { parseCheckOptions, USAGE, type CheckOptions } from './marketplace-e2e/options';

const EXIT_OK = 0;
const EXIT_MISMATCH = 1;
const EXIT_USAGE = 2;
const EXIT_REQUEST_FAILED = 3;

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function observeOrg(options: CheckOptions, observed: ObservedState): Promise<void> {
  const loginResult = await login(options.baseUrl, options.email, options.password);
  if (loginResult.kind === 'refused') {
    observed.loginRefusalCode = loginResult.code;
    const implied = statusFromLoginRefusal(loginResult.code) ?? 'unknown';
    print(`Login:          refused with ${loginResult.code} (implies status ${implied})`);
    return;
  }
  print('Login:          ok');

  const subscription = await getSubscription(options.baseUrl, loginResult.accessToken);
  observed.subscription = subscription;
  print(`Source:         ${subscription.source}`);
  print(`Status:         ${subscription.status}`);
  print(`Camera limit:   ${subscription.cameraLimit ?? 'unlimited'}`);
  print(`Expires at:     ${subscription.expiresAt ?? 'never'}`);

  // Every other org route is refused unless the subscription is active.
  if (subscription.status !== 'active') {
    print('Cameras:        skipped (the API refuses camera requests unless status is active)');
    return;
  }
  const activeCameras = await countActiveCameras(options.baseUrl, loginResult.accessToken);
  observed.activeCameras = activeCameras;
  print(`Cameras:        ${describeCameraUsage(activeCameras, subscription.cameraLimit)}`);
}

async function runReconcile(options: CheckOptions, observed: ObservedState): Promise<void> {
  if (!options.reconcile || !options.internalApiSecret) return;
  const result = await reconcile(options.baseUrl, options.internalApiSecret);
  observed.reconcile = result;
  print(
    `Reconcile:      checked ${result.checked}, changed ${result.changed}, failed ${result.failed}`,
  );
}

async function main(): Promise<number> {
  const parsed = parseCheckOptions(process.argv.slice(2), process.env);
  if (parsed.kind === 'help') {
    print(USAGE);
    return EXIT_OK;
  }
  if (parsed.kind === 'error') {
    console.error(`${parsed.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  const { options } = parsed;
  print(`API:            ${options.baseUrl}`);
  const observed: ObservedState = {};
  try {
    await observeOrg(options, observed);
    await runReconcile(options, observed);
  } catch (err) {
    const reason = err instanceof ApiRequestError ? err.message : String(err);
    console.error(`Request failed: ${reason}`);
    return EXIT_REQUEST_FAILED;
  }

  const mismatches = findMismatches(observed, options.expectations);
  if (mismatches.length > 0) {
    mismatches.forEach((mismatch) => console.error(`FAIL ${mismatch}`));
    return EXIT_MISMATCH;
  }
  print('PASS');
  return EXIT_OK;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(EXIT_REQUEST_FAILED);
  },
);
