# Decisions Log

Durable trail of build-vs-adopt (and other notable) decisions.

## 2026-08-22 — api.olympusvisions.com DNS + HTTPS after AWS account move

**Context:** Domain moved to a new AWS account; nameservers repointed. Frontend
(`olympusvisions.com`, CloudFront) resolved fine, but `api.olympusvisions.com`
returned NXDOMAIN → browser `ERR_NAME_NOT_RESOLVED` on all API/login calls. Root
cause: DNS records were created manually in the old account's console (Terraform
had zero `aws_route53_*` resources), so the `api` A-record was never recreated in
the new account's hosted zone. Frontend calls the API over **HTTPS**, but the ALB
had an **HTTP-only (port 80) listener** and no ACM cert — so DNS alone was
insufficient.

**Options considered:**
- Manual console fix (quick, but re-creates the same untracked drift that caused
  the outage; lost on the next account move).
- Codify in Terraform using **native AWS provider resources** (ACM DNS-validated
  cert + 443 listener + Route 53 alias). No third-party module needed — the
  hashicorp/aws provider covers this directly; a community module (e.g.
  terraform-aws-modules/acm) would add a dependency for ~40 lines of stable HCL.

**Decision:** Codify in Terraform with native provider resources. Added to the
`compute` module, gated on `var.api_domain` (empty = HTTP-only fallback, module
still applies without a domain). Existing hosted zone is looked up via
`data "aws_route53_zone"` (NOT created) so the working frontend zone is untouched.
HTTP:80 now 301-redirects to HTTPS. Lambda `internal_api_url` repointed to the
HTTPS custom domain so its `fetch()` POSTs skip the redirect.

**Why:** Version-controlled DNS/TLS prevents this exact outage from recurring on
future account moves; native resources avoid an unnecessary dependency for a small
amount of stable config.

## 2026-11-24 — AWS Marketplace SaaS contract integration

**Context:** Sell Olympusvisions as a SaaS contract on AWS Marketplace, register
buyers through the existing website, and gate access (camera count) on the
contract. Plan: `docs/plans/aws-marketplace-integration.md`.

**Options considered:**
- **aws-samples/aws-marketplace-serverless-saas-integration** (AWS's reference
  sample, SAM). Its own stack (DynamoDB, separate landing page, Lambda-only)
  conflicts with our requirements (existing website, PostgreSQL, Fastify
  auth); some mirrors show it as archived. Useful as a reference, not to adopt.
- **Third-party npm wrappers:** none found that is maintained; one blog project
  is an app, not a library.
- **Official AWS SDK v3 clients** (`@aws-sdk/client-marketplace-metering`,
  `@aws-sdk/client-marketplace-entitlement-service`, Apache-2.0, maintained by
  AWS, same SDK family already used in the repo) plus a thin service of our own.

**Decision:** Adopt the official SDK v3 clients; build a small service on top
that follows our existing patterns (Fastify routes, PostgreSQL, Redis,
Lambda → `/internal/*`, Terraform). Every event and scheduled check re-reads
`GetEntitlements`, so event ordering and duplicates do not matter.

## 2026-11-24 — AWS Marketplace end-to-end check script (PR 4/4)

**Context:** A read-only CLI that each step of `marketplace/E2E-RUNBOOK.md` uses to
confirm the org's subscription status and camera limit on staging.

**Options considered:**
- **API test runners** (Newman with the existing Postman collection, Hurl): good
  for request/response checks, but awkward for "login refused means cancelled",
  combining several calls into one verdict, and gating the one write call
  (reconcile) behind a flag.
- **Node built-ins** (`node:util` `parseArgs`, global `fetch`) run with the `tsx`
  already in devDependencies: no new dependencies, and the logic is plain
  TypeScript that the repo's Jest setup can unit test.

**Decision:** Built-ins. The script and its helpers are under 500 lines with no new packages. The
argument parsing and pass/fail logic are pure functions, unit tested in
`tests/scripts/`.
