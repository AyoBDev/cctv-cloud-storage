# Postman Collection — CCTV Cloud Storage API

This is the **single source of truth** for all API contracts. Maintained by the backend team and committed to the repository. API shapes are agreed every Monday before sprint coding begins.

## Files

| File | Purpose |
|------|---------|
| `CCTV-Cloud-Storage.postman_collection.json` | Main collection — all endpoints, test scripts, example responses |
| `CCTV-Cloud-Storage.local.postman_environment.json` | Local dev environment variables |
| `CCTV-Cloud-Storage.staging.postman_environment.json` | Staging environment variables (update `baseUrl` and `adminPassword`) |

## Quick Start

1. Open Postman → **Import** → select both the collection and your desired environment file
2. Set the environment to **CCTV Cloud Storage — Local** (or Staging)
3. Run **Admin / Auth → Login** — tokens are stored automatically in collection variables
4. All protected requests will use `{{accessToken}}` from there

## Collection Structure

```
CCTV Cloud Storage API
├── Health
│   └── GET /health
├── Admin / Auth
│   ├── POST /api/v1/admin/auth/login
│   ├── POST /api/v1/admin/auth/refresh
│   └── POST /api/v1/admin/auth/logout
└── ⚙️ Workflow — Full Auth Lifecycle
    ├── Step 1 — Login
    ├── Step 2 — Refresh Tokens
    ├── Step 3 — Logout
    └── Step 4 — [Verify] Refresh after logout → 401
```

## Auto-token Management

The collection handles tokens automatically:

| Event | Action |
|-------|--------|
| Login succeeds (200) | Stores `accessToken` + `refreshToken` in collection variables |
| Refresh succeeds (200) | Rotates both tokens in collection variables |
| Logout succeeds (204) | Clears both tokens from collection variables |

All requests in the `Admin / Auth` folder that require auth already have `Authorization: Bearer {{accessToken}}` configured.

## Test Scripts

Every request has built-in test scripts that run in the **Tests** tab:

- **Status code** assertion
- **Response shape** validation
- **Token rotation** confirmation (refresh token must differ)
- **Error envelope** validation (all 4xx/5xx check for `{ error: { code, message } }`)
- **Response time** check on health endpoint (< 500ms)

Run the **⚙️ Workflow — Full Auth Lifecycle** folder with the Collection Runner to execute the entire flow end-to-end.

## Updating the Collection

When a new sprint adds endpoints:

1. Add the new requests under the appropriate folder
2. Include at least one success and one error example response (saved as **Examples**)
3. Add test scripts for status code, response shape, and any tokens/IDs to persist
4. Update this README's structure table
5. Commit the updated `.json` file — it is reviewed as part of the Monday API contract review

## Environments

| Variable | Local | Staging | Notes |
|----------|-------|---------|-------|
| `baseUrl` | `http://localhost:3000` | `https://api-staging...` | Override per environment |
| `adminEmail` | `admin@cctv-cloud.local` | Same | Set by seed script |
| `adminPassword` | `changeme123!` | **Set manually, never commit** | Secret type in Postman |
| `accessToken` | _(auto)_ | _(auto)_ | Populated by Login script |
| `refreshToken` | _(auto)_ | _(auto)_ | Populated by Login script |

> **Security**: `adminPassword` and `refreshToken` are marked as `secret` type in the environment. Postman will not sync these to the cloud if you use Postman's built-in secret masking. Never hardcode passwords in the collection file itself.
