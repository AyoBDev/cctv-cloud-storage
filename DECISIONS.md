# Build-vs-Adopt Decisions

## 2026-08-22 — Camera status reconciler (auto online/offline)

**Feature:** Automatically keep each camera's DB `status` in sync with whether
its KVS stream is receiving fragments, so live view and recording work without
per-device setup. (Root cause of the original bug: cameras streamed to KVS but
never transitioned from `provisioning` → `online`, so `/stream` returned 400 and
recording skipped them.)

**Options considered:**
- **Device-side reporter** (wrapper script + systemd on each Raspberry Pi that
  POSTs status on producer start/stop). Signals: no new infra; but requires
  touching every device, doesn't self-heal on crash between reports, and scales
  poorly with camera count.
- **Cloud reconciler that derives status from KVS** (scheduled Lambda →
  `ListFragments` → internal API). Signals: zero device setup, self-healing,
  status reflects ground truth, reuses existing Lambda role/schedule patterns.
- **Off-the-shelf tooling:** none fits. This is glue over the AWS SDK
  (`ListFragments`) and our own internal API; there is no library/service that
  reconciles "KVS has recent media" → "our camera status" for our schema. A
  generic uptime/health-check tool (e.g. an HTTP monitor) doesn't apply — the
  signal is KVS fragment presence, not an HTTP endpoint.

**Decision: BUILD** the cloud reconciler. No suitable open-source component
exists for this domain-specific reconciliation; the implementation is a thin,
well-bounded Lambda plus two internal endpoints, mirroring the existing
recording-archiver Lambda pattern already in the repo.

**Also fixed in passing:** the Lambda `internal_api_url` was `http://<alb-dns>`,
which 301-redirects to HTTPS and drops POST bodies — this silently broke the
existing recording-archiver's webhook too. Changed to
`https://api.olympusvisions.com`.
