# AWS Marketplace end-to-end test (staging)

A person runs this runbook once the listing exists. It walks one test buyer through
subscribe → sign up → camera limit → upgrade → reconcile → cancel, and says how to
confirm each step and where to look when one fails.

> This file lives in `marketplace/` because `docs/` is gitignored.

Placeholders used below. Replace them with real values in your own shell, never in this file:

| Placeholder | Meaning |
| --- | --- |
| `111122223333` | Test **buyer** AWS account ID |
| `444455556666` | **Seller** AWS account ID (owns the listing) |
| `777788889999` | **App** AWS account ID (ECS, Lambda, SQS) |
| `abc123exampleproductcode` | Listing product code (a random-looking string, not the `prod-...` product ID) |
| `cameras` | Camera dimension API name |
| `jane.doe@example.com` | Org Admin email used for the test org |

---

## 1. Prerequisites

Tick every box before you start. Most failures come from a skipped prerequisite.

- [ ] **PRs merged and deployed to staging:** PR 1 (registration, signup, link),
      PR 2 (events, reconcile, access checks, camera limit) and PR 3 (Lambda + Terraform).
      Migrations `014_marketplace` and `015_marketplace_events` have run.
- [ ] **Listing values received from the CTO:** seller account ID, product code,
      camera dimension API name, access role ARN, whether there is a free trial,
      and the test buyer account ID.
- [ ] **Terraform applied in this order** (see `terraform/seller/README.md`):
  1. App staging stack (`terraform/environments/staging`) with empty seller values.
     This creates the task role and event buses.
  2. Seller stack (`terraform/seller/`), applied by the CTO with **seller** credentials,
     using the staging outputs `marketplace_app_task_role_arn` and
     `marketplace_app_event_bus_arn`.
  3. App staging stack again, now with `marketplace_seller_account_id`,
     `marketplace_seller_role_arn`, `marketplace_product_code` and
     `marketplace_camera_dimension` set.
- [ ] **Staging ECS task has the env values** (check the running task definition, not
      just Terraform):
  - `MARKETPLACE_PRODUCT_CODE` = the listing's product code
  - `MARKETPLACE_CAMERA_DIMENSION` = the camera dimension API name
  - `MARKETPLACE_SELLER_ROLE_ARN` = the seller's `api_access_role_arn` output
- [ ] **Fulfillment URL** on the listing is exactly
      `https://api.olympusvisions.com/api/v1/marketplace/register`.
- [ ] **Test buyer allowlisted:** the listing is in *Limited* state and the test buyer
      account `111122223333` is on its allowlist. Ideally use a **$0 private offer** for
      that account, so the test costs nothing (see [Cleanup](#5-cleanup)).
- [ ] **Alerts:** the SNS email subscription for `cctv-staging-marketplace-alerts` is
      confirmed, so a message in the DLQ emails you.
- [ ] **Read access** to staging CloudWatch, SQS and EventBridge in the app account, and
      to EventBridge in the seller account (or someone on hand who has it).
- [ ] A way to run **read-only SQL** against the staging database (e.g. a bastion or
      SSM session). The queries in [section 4](#4-sql-snippets) only `SELECT`.

### Shell setup for the check script

The check script is read-only. It logs in, reads the org's subscription and counts its
cameras. It writes only when you pass `--reconcile`. It reads secrets **only** from env
vars. Type them in; don't put them in files or shell history.

```bash
export BASE_URL=https://api.olympusvisions.com
export E2E_ORG_ADMIN_EMAIL=jane.doe@example.com   # the email you sign up with in step 2
read -rs E2E_ORG_ADMIN_PASSWORD && export E2E_ORG_ADMIN_PASSWORD
# Only for steps that pass --reconcile. Get it from whoever owns the staging secret.
read -rs INTERNAL_API_SECRET && export INTERNAL_API_SECRET
```

```bash
npx tsx scripts/marketplace-e2e-check.ts --help
```

Exit codes: `0` all checks passed, `1` an expectation did not match, `2` usage error,
`3` a request failed (network, 401, 5xx).

---

## 2. Test steps

Each step says what to do, what should happen, and how to confirm it.

### Step 1: Subscribe to a small contract

**Do:** signed in to the **test buyer** account `111122223333`, open the listing (or the
private offer) and subscribe to a contract for **2 cameras**. Click *Set up your account*.

**Expect:**
- The browser POSTs to `/api/v1/marketplace/register` and is redirected (303) to the
  website registration page with `?ref=<reference>` in the URL, **not** `?error=...`.
- A row in `marketplace_registrations` for `111122223333`, with `consumed_at` empty and
  `expires_at` about 60 minutes away.
- A `Purchase Agreement Created - Proposer` (or `- Manufacturer`) event, and possibly
  `License Updated - ...`, in `marketplace_events` within a minute or two. Because no
  org is linked yet, they are stored but not processed: `processed_at` and `error`
  are both empty. That is expected, because signup runs its own entitlement sync.

**Check:**
- The address bar shows `?ref=`. If it shows `?error=token_invalid`, `?error=...` or
  `?error=unavailable`, see [Troubleshooting](#3-where-to-look-when-a-step-fails).
- SQL: [registrations](#registrations-for-one-account) and [events](#latest-events-for-one-account).
- This is the first proof that the **double hop** works: seller us-east-1 → app
  us-east-1 → app eu-west-1 → SQS. If no event row appears within 5 minutes, stop
  and debug the event path before going on.

### Step 2: Sign up on the website

**Do:** on the registration page, create a new organization with Org Admin
`jane.doe@example.com` and a password.

**Expect:**
- The org is created and linked: a `marketplace_customers` row with `org_id` set,
  `aws_account_id = 111122223333`, `status = active`, `camera_limit = 2`.
- The registration row now has `consumed_at` set.
- If AWS has not activated the license yet, `status` may briefly be
  `pending_activation`. The `License Updated` event, or the next reconcile, flips it
  to `active`.

**Check:**

```bash
npx tsx scripts/marketplace-e2e-check.ts --base-url "$BASE_URL" --expect-status active --expect-limit 2
```

Expected output includes `Source: aws_marketplace`, `Status: active`, `Camera limit: 2`
and `PASS`. SQL: [customer](#customer-for-one-account).

### Step 3: Camera limit

**Do:** as the Org Admin, add **2 cameras** on the website, then try a **third**.

> Each camera creates real staging resources (IoT thing, KVS stream). Delete the test
> cameras in [Cleanup](#5-cleanup).

**Expect:**
- The first two succeed.
- The third is refused with **403** and error code **`CAMERA_LIMIT_REACHED`**. The
  website shows the "upgrade your subscription in AWS Marketplace" message.

**Check:**

```bash
npx tsx scripts/marketplace-e2e-check.ts --base-url "$BASE_URL" --expect-status active --expect-limit 2
```

The `Cameras:` line reads `2 / 2 active (at the limit ...)`. In the browser's network
tab, the failed `POST /api/v1/cameras` response body has
`"code": "CAMERA_LIMIT_REACHED"`.

### Step 4: Upgrade the contract

**Do:** in the buyer account, amend or upgrade the contract to, for example,
**5 cameras**.

**Expect:**
- Within a few minutes, a `License Updated - ...` and/or `Purchase Agreement Amended - ...`
  event in `marketplace_events` for `111122223333`, with `processed_at` set and
  `error` empty.
- `marketplace_customers.camera_limit` = 5. The org-access cache is cleared on every
  sync, so the next API request sees the new limit.
- The third camera from step 3 can now be added.

**Check:**

```bash
npx tsx scripts/marketplace-e2e-check.ts --base-url "$BASE_URL" --expect-status active --expect-limit 5
```

SQL: [events](#latest-events-for-one-account) and [customer](#customer-for-one-account).

### Step 5: Reconcile

**Do:** run a reconcile, which re-syncs every Marketplace customer with AWS.
`--reconcile` is the only flag that makes the script write. It does exactly what the
scheduled Lambda does.

**Expect:** `changed: 0`. Events have already brought the database in line with AWS.
`failed` must be 0.

**Check:**

```bash
npx tsx scripts/marketplace-e2e-check.ts --base-url "$BASE_URL" --reconcile --expect-changed 0 --expect-limit 5
```

If `changed` is above 0, an event was lost or processed wrongly. Look in the API logs
for `Marketplace customer entitlement changed during reconcile`, which logs the
before and after values.

### Step 6: Cancel

**Do:** first save a current access token, so you can prove that a token issued before
the cancellation stops working at once:

```bash
ACCESS_TOKEN=$(curl -sS -X POST "$BASE_URL/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$E2E_ORG_ADMIN_EMAIL\",\"password\":\"$E2E_ORG_ADMIN_PASSWORD\"}" | jq -r .accessToken)
```

Then, in the buyer account, **cancel** the subscription.

**Expect:**
- Within a few minutes, a `Purchase Agreement Ended - ...` and/or `License Deprovisioned - ...` event in
  `marketplace_events`, and `marketplace_customers.status = cancelled`.
- The **next** request with the old token gets **403 `SUBSCRIPTION_INACTIVE`**. It does
  not wait for the 15-minute token expiry.
- Login is refused with 403 `SUBSCRIPTION_INACTIVE`.

**Check:**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $ACCESS_TOKEN" "$BASE_URL/api/v1/cameras"   # 403
curl -sS -H "authorization: Bearer $ACCESS_TOKEN" "$BASE_URL/api/v1/cameras" | jq .error.code                     # "SUBSCRIPTION_INACTIVE"
```

```bash
npx tsx scripts/marketplace-e2e-check.ts --base-url "$BASE_URL" --expect-status cancelled
```

The script prints `Login: refused with SUBSCRIPTION_INACTIVE (implies status cancelled)`
and `PASS`.

### Step 7 (optional): Link a purchase to an existing org

This checks the *I already have an account* path. It needs a **second** buyer account,
because one AWS account links to only one org and step 2 already linked
`111122223333`. It also needs an existing org that is **not** Marketplace-linked
(created by the Super Admin).

**Do:** from the second buyer account, subscribe. On the registration page choose
*link to an existing organization*, sign in as that org's Org Admin and confirm.
Behind the scenes this calls `POST /api/v1/marketplace/registrations/<ref>/link`.

**Expect:** a new `marketplace_customers` row for that org with `status = active` and
the purchased `camera_limit`. Before linking the org had no limit; it now has one.

**Check:** run the script with that org's Org Admin credentials and
`--expect-status active --expect-limit <n>`. Try linking the same AWS account again;
it should fail with `MARKETPLACE_ACCOUNT_ALREADY_LINKED`. Linking a second purchase
to the same org should fail with `ORG_ALREADY_LINKED`.

---

## 3. Where to look when a step fails

The event path, end to end:

```
seller us-east-1 default bus ──rule marketplace-forward-to-app──▶
app us-east-1 default bus ──rule cctv-staging-marketplace-forward──▶
app eu-west-1 default bus ──rule cctv-staging-marketplace-events──▶
SQS cctv-staging-marketplace-events (DLQ: cctv-staging-marketplace-events-dlq) ──▶
Lambda cctv-staging-marketplace-events ──▶ POST /internal/marketplace/events ──▶ API
```

Work from the end the symptom is closest to. The commands below only read.

### CloudWatch logs (app account, eu-west-1)

| What | Log group |
| --- | --- |
| API (registration, signup, events, reconcile, access checks) | `/cctv/staging/api` |
| Marketplace Lambda (SQS consumer and scheduled reconcile) | `/aws/lambda/cctv-staging-marketplace-events` |

```bash
aws logs tail /cctv/staging/api --since 30m --region eu-west-1 --filter-pattern '"arketplace"'
aws logs tail /aws/lambda/cctv-staging-marketplace-events --since 30m --region eu-west-1
```

Common API errors:
- Redirect with `?error=token_invalid`: the `x-amzn-marketplace-token` was missing or
  rejected by `ResolveCustomer`.
- `?error=unavailable`, or `AccessDenied` in the logs: the task cannot assume
  `MARKETPLACE_SELLER_ROLE_ARN`, or the role lacks
  `aws-marketplace:ResolveCustomer`/`GetEntitlements`. Check the role ARN in the
  task, and the seller role's trust policy, which names the app task role.
- Product code mismatch: `MARKETPLACE_PRODUCT_CODE` does not match the listing.
- Limit stays 0 or the status stays `pending_activation`:
  `MARKETPLACE_CAMERA_DIMENSION` does not match the dimension API name, so no
  entitlement is picked up.

### SQS queue and DLQ depth (app account, eu-west-1)

```bash
for q in cctv-staging-marketplace-events cctv-staging-marketplace-events-dlq; do
  url=$(aws sqs get-queue-url --queue-name "$q" --region eu-west-1 --query QueueUrl --output text)
  aws sqs get-queue-attributes --queue-url "$url" --region eu-west-1 \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
done
```

- Main queue growing: the Lambda isn't consuming, or the API keeps returning errors.
  Check the Lambda logs.
- DLQ not empty: an event failed 5 times. Read the message in the console (*Poll for
  messages*) without deleting it, and match its `id` to
  `marketplace_events.event_id`. After fixing the cause, redrive it from the console.

### EventBridge rule metrics

In CloudWatch → Metrics → `AWS/Events`, per rule: `MatchedEvents`,
`Invocations`, `FailedInvocations`, `TriggeredRules`.

| Account / region | Rule | If `MatchedEvents` is 0 | If `FailedInvocations` > 0 |
| --- | --- | --- | --- |
| Seller, us-east-1 | `marketplace-forward-to-app` | Marketplace emitted nothing for the listing, or the pattern doesn't match | The app us-east-1 bus policy doesn't allow seller account `444455556666` (`marketplace_seller_account_id` unset) |
| App, us-east-1 | `cctv-staging-marketplace-forward` | Seller forwarding failed (row above) | Forwarder role can't `PutEvents` to the eu-west-1 bus |
| App, eu-west-1 | `cctv-staging-marketplace-events` | The us-east-1 → eu-west-1 hop failed | The SQS queue policy doesn't allow the rule |

```bash
aws cloudwatch get-metric-statistics --namespace AWS/Events --metric-name MatchedEvents \
  --dimensions Name=RuleName,Value=cctv-staging-marketplace-events \
  --start-time "$(date -u -v-1H +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 300 --statistics Sum --region eu-west-1
```

(On Linux use `date -u -d '-1 hour' +%FT%TZ`.)

### `marketplace_events.error`

Every event that reached the API is stored, whatever happened next. A row with
`error` set and `processed_at` empty failed to sync with AWS. The API returned 503,
so SQS retries it, up to 5 times before the DLQ. A row with both empty for a
**linked** account means the event arrived before signup, or is a detail type we
only store. The error text says why. See [failed events](#events-that-failed).
No row at all means the event never reached the API, so look further up the path.

---

## 4. SQL snippets

Read-only. Replace `111122223333` with the test buyer account ID in your session, not in
this file.

#### Registrations for one account

```sql
SELECT id, aws_account_id, product_code, agreement_id, is_free_trial,
       created_at, expires_at, consumed_at
FROM marketplace_registrations
WHERE aws_account_id = '111122223333'
ORDER BY created_at DESC
LIMIT 5;
```

#### Customer for one account

```sql
SELECT mc.id, mc.org_id, o.name AS org_name, o.is_active AS org_is_active,
       mc.status, mc.camera_limit, mc.entitlement_expires_at, mc.last_synced_at,
       mc.agreement_id, mc.updated_at,
       (SELECT COUNT(*) FROM cameras c WHERE c.org_id = mc.org_id AND c.is_active) AS active_cameras
FROM marketplace_customers mc
JOIN organizations o ON o.id = mc.org_id
WHERE mc.aws_account_id = '111122223333';
```

#### Latest events for one account

```sql
SELECT event_id, detail_type, agreement_id, received_at, processed_at, error
FROM marketplace_events
WHERE aws_account_id = '111122223333'
ORDER BY received_at DESC
LIMIT 20;
```

#### Events that failed

```sql
SELECT event_id, detail_type, aws_account_id, received_at, error
FROM marketplace_events
WHERE error IS NOT NULL
ORDER BY received_at DESC
LIMIT 20;
```

---

## 5. Cleanup

1. **Cancel the test subscription** in the buyer account, if step 6 didn't. With a
   **$0 private offer** for the test buyer, the whole test costs nothing. With a
   paid public contract, AWS bills the buyer account for the contract.
2. **Delete the test cameras** from step 3 on the website, so their IoT things and KVS
   streams are removed.
3. Leave the database rows in place. `marketplace_events` is an audit log, and the
   cancelled `marketplace_customers` row keeps account `111122223333` bound to the
   test org (one AWS account, one org). To test signup again from scratch with the
   same buyer account, ask an engineer to remove that customer row deliberately.
   Don't do it as part of this runbook.
4. Remove the secrets from your shell:
   `unset E2E_ORG_ADMIN_PASSWORD INTERNAL_API_SECRET ACCESS_TOKEN`.
