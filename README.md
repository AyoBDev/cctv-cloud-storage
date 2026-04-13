# CCTV Cloud Storage

A multi-tenant SaaS platform for CCTV camera management with face recognition, built on AWS. Organizations can register cameras, stream live video, store recordings, and receive real-time alerts when known or unknown faces are detected.

## Features

- **Multi-Tenant Architecture** — Full org-level data isolation; every query is scoped to the authenticated organization
- **Camera Management** — Register cameras, provision AWS Kinesis Video Streams automatically, manage RTSP connections
- **Live Streaming** — HLS live view with 15-minute signed URLs via Kinesis Video Streams
- **Cloud Recordings** — Video stored in S3 with automatic Glacier transition after 30 days; pre-signed URLs for playback
- **Face Recognition** — AWS Rekognition integration with per-org face collections, profile management, and real-time event detection
- **Recognition Alerts** — Lambda pipeline processes video fragments, matches faces, and triggers email alerts (SES) for unknown faces
- **Role-Based Access** — Super Admin (platform-wide), Org Admin (manages their org), and Viewer roles with RS256 JWT auth
- **Infrastructure as Code** — Full Terraform setup for staging and production environments

## Tech Stack

| Layer | Technology |
|---|---|
| API | [Fastify v5](https://fastify.io/) (TypeScript) |
| Database | PostgreSQL |
| Cache | Redis (via [ioredis](https://github.com/redis/ioredis)) |
| Auth | RS256 JWT (15-min access + 7-day refresh tokens) |
| Validation | [Zod](https://zod.dev/) |
| Cloud | AWS (ECS, S3, KVS, Rekognition, Lambda, SES, KMS, IoT) |
| IaC | [Terraform](https://www.terraform.io/) |
| CI/CD | GitHub Actions |
| Logging | [Pino](https://getpino.io/) |

## Architecture

```
                    ┌──────────────┐
                    │   Clients    │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │     ALB      │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  ECS Fargate │
                    │  (Fastify)   │
                    └──┬───┬───┬───┘
                       │   │   │
              ┌────────┘   │   └────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Postgres │ │  Redis   │ │   AWS    │
        │  (RDS)   │ │(ElastiC.)│ │ Services │
        └──────────┘ └──────────┘ └────┬─────┘
                                       │
                    ┌──────┬───────┬────┴──┬──────┐
                    ▼      ▼       ▼       ▼      ▼
                   S3    KVS   Rekognition Lambda  SES
```

## API Routes

| Prefix | Description | Auth |
|---|---|---|
| `/api/v1/admin/*` | Super Admin — platform management | Super Admin JWT |
| `/api/v1/auth/*` | Org user authentication | Public / JWT |
| `/api/v1/org/*` | Org Admin — team management | Org Admin JWT |
| `/api/v1/cameras/*` | Camera CRUD & streaming | Org-scoped JWT |
| `/api/v1/face-profiles/*` | Face profile management | Org-scoped JWT |
| `/api/v1/recognition-events/*` | Recognition event feed | Org-scoped JWT |
| `/internal/*` | Lambda-to-API callbacks | Shared secret |
| `/health` | Health check (DB + Redis + KVS) | None |

## Prerequisites

- **Node.js** >= 20.0.0
- **PostgreSQL** (local or remote)
- **Redis** (local or remote)
- **AWS Account** with appropriate IAM permissions (for KVS, S3, Rekognition, KMS, SES, IoT)

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/AyoBDev/cctv-cloud-storage.git
cd cctv-cloud-storage
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

Create a `.env` file in the project root:

```env
# Server
PORT=3000
HOST=0.0.0.0
NODE_ENV=development

# Database
DATABASE_URL=postgres://user:password@localhost:5432/cctv_dev

# Redis
REDIS_URL=redis://localhost:6379

# JWT (RS256 — generate a keypair with openssl)
JWT_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES=7d

# AWS
AWS_REGION=eu-west-2
AWS_ACCESS_KEY_ID=your-key        # Only for local dev; use IAM roles in production
AWS_SECRET_ACCESS_KEY=your-secret

# KMS (for encrypting RTSP URLs at rest)
KMS_KEY_ID=your-kms-key-id

# Internal API (Lambda → API callback auth)
INTERNAL_API_SECRET=your-shared-secret

# Super Admin seed credentials
SUPER_ADMIN_EMAIL=admin@example.com
SUPER_ADMIN_PASSWORD=your-secure-password
```

> **Generating RS256 keys:**
> ```bash
> openssl genrsa -out private.pem 2048
> openssl rsa -in private.pem -pubout -out public.pem
> ```
> Then paste the contents into your `.env` file (replace newlines with `\n`).

### 4. Run database migrations

```bash
npm run migrate
```

### 5. Seed the super admin

```bash
npm run seed
```

### 6. Start the development server

```bash
npm run dev
```

The API will be available at `http://localhost:3000`. Verify with:

```bash
curl http://localhost:3000/health
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload (tsx) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build |
| `npm run lint` | Run ESLint |
| `npm run format` | Format code with Prettier |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run tests (Jest) |
| `npm run test:ci` | Run tests with coverage and `--forceExit` |
| `npm run migrate` | Run database migrations up |
| `npm run migrate:down` | Roll back the last migration |
| `npm run seed` | Seed the super admin user |

## Docker

Build and run the production image:

```bash
docker build -t cctv-cloud-storage .
docker run -p 3000:3000 --env-file .env cctv-cloud-storage
```

## Infrastructure (Terraform)

The `terraform/` directory contains the full IaC setup:

```
terraform/
├── bootstrap/          # One-time: S3 state bucket + DynamoDB lock table
├── environments/
│   └── staging/        # Staging environment config
├── modules/
│   ├── networking      # VPC, subnets, security groups, NAT
│   ├── iam             # ECS task roles, Lambda execution role
│   ├── database        # RDS PostgreSQL + ElastiCache Redis
│   ├── compute         # ECS cluster, ALB, task definitions
│   ├── storage         # S3 video + media buckets
│   ├── lambda          # Face recognition function
│   ├── notifications   # SES domain verification
│   └── iot             # IoT device provisioning
└── scripts/
    └── push-secrets-to-ssm.sh  # Push secrets to AWS SSM Parameter Store
```

Apply order: `networking` → `storage` → `iam` → `database` → `compute` → `lambda` → `notifications`

## Postman Collection

The `postman/` directory contains the API collection and environment files — the **single source of truth** for API contracts:

- `CCTV-Cloud-Storage.postman_collection.json` — Full API collection
- `CCTV-Cloud-Storage.local.postman_environment.json` — Local environment
- `CCTV-Cloud-Storage.staging.postman_environment.json` — Staging environment

Import both the collection and an environment file into [Postman](https://www.postman.com/) to explore and test the API. The collection includes auto-token management (login stores tokens, refresh rotates them, logout clears them).

## Project Structure

```
src/
├── config/          # Environment config (Zod-validated)
├── db/
│   ├── migrations/  # Database migrations (node-pg-migrate)
│   └── seed.ts      # Super admin seeder
├── middleware/       # Auth middleware (requireSuperAdmin, requireUser, etc.)
├── plugins/         # Fastify plugins (database, redis, AWS clients)
├── routes/
│   ├── admin/       # Super Admin routes
│   ├── auth/        # Org user auth routes
│   ├── cameras/     # Camera management routes
│   ├── internal/    # Lambda callback routes
│   └── org/         # Org Admin routes
├── services/        # Business logic layer
├── utils/           # JWT, KMS, helpers
├── app.ts           # Fastify app factory
└── server.ts        # Entry point
```

## Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:ci
```

Tests use a separate test database and mock AWS services. Configure `DATABASE_URL` in `.env` to point to your test database when running tests.

## License

All rights reserved.
