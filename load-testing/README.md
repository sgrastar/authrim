---
project: Authrim
lang: en
date: 2026-01-19
description: 'Load testing framework for Authrim OIDC Provider using K6.'
type: reference
tags:
  - authrim
  - load-testing
  - performance
  - oidc
  - testing
---

# Authrim Load Testing

Load testing framework for Authrim OIDC Provider using K6.

> **See also**: [Testing Guide](../docs/getting-started/testing.md) for unit tests, E2E tests, conformance tests, and other test types.
>
> **Scope note**:
>
> - This folder is primarily for throughput / capacity benchmarking.
> - Some benchmark or seed flows assume benchmark-only helpers or permissive preconditions that are not always available in a hardened deployed environment.
> - For generated/deployed env validation against supported APIs only, use
>   `test/generated-environment/load-generated-live-safe.ts`.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Available Benchmarks](#available-benchmarks)
- [Seed Scripts](#seed-scripts)
- [Reports](#reports)
- [Directory Structure](#directory-structure)

---

## Overview

This framework measures the performance and capacity of Authrim OIDC endpoints:

- **Token Introspection** (`POST /introspect`) - RFC 7662 token validation
- **Token Exchange** (`POST /token`) - RFC 8693 token exchange
- **UserInfo** (`GET /userinfo`) - OIDC UserInfo endpoint
- **Silent Auth** (`GET /authorize?prompt=none`) - SSO silent authentication
- **Refresh Token Rotation** (`POST /token`) - Token refresh with rotation
- **Audit-heavy Token Activity** (`POST /token`) - refresh-token activity with audit sink focus
- **Full Login Flows** - Complete OAuth flows with Mail OTP or Passkey
- **SCIM Provisioning** (`POST/GET/PATCH /scim/v2/Users`) - single-resource lifecycle load
- **SCIM Bulk Provisioning** (`POST /scim/v2/Bulk`) - batched account creation load

### Performance Highlights

| Endpoint                        | Recommended RPS | Peak RPS | Key Finding                        |
| ------------------------------- | --------------- | -------- | ---------------------------------- |
| Silent Auth (128 shards)        | 2,500           | 3,500    | DO sharding eliminates errors      |
| Refresh Token (48 shards)       | 2,500           | 3,000    | Linear shard scaling               |
| UserInfo                        | 2,000           | 2,500    | JWT validation stable at 1-4ms CPU |
| Token Exchange                  | 1,500           | 2,500    | 100% token validation accuracy     |
| Token Introspection (32 shards) | 300             | 500      | Region-aware JTI sharding          |
| Full Login (32 shards)          | 100 LPS         | 150 LPS  | 91% P95 latency reduction          |

See [Reports](#reports) for detailed analysis.

---

## Architecture

```mermaid
flowchart TB
    subgraph LoadGen["Load Generator"]
        k6["K6 (Local or Cloud)"]
    end

    subgraph CF["Cloudflare"]
        Edge["Cloudflare Edge"]

        subgraph Worker["Authrim Workers"]
            W["ar-auth / ar-token / ar-management"]
        end

        subgraph Storage["Storage Layer"]
            KV["KV (config, JWK cache)"]
            DO["Durable Objects (sharded)"]
            D1["D1 (sessions, tokens)"]
        end
    end

    k6 --> Edge
    Edge --> W
    W --> KV
    W --> DO
    W --> D1
```

**Key Insight**: Durable Objects are the bottleneck, not CPU. Sharding DO improves throughput linearly.

---

## Quick Start

### Prerequisites

- [K6](https://k6.io/) - Load testing tool
- Node.js 18+ - For seed scripts
- Test client credentials (see [Seed Scripts](#seed-scripts))

### 1. Install K6

```bash
# macOS
brew install k6

# Linux
sudo apt-get install k6
```

### 2. Run a Benchmark

```bash
cd load-testing

# Example: UserInfo benchmark at 500 RPS
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env TOKEN_URL=https://your-r2-bucket.example.com/seeds/tokens.json \
  --env PRESET=rps500 \
  scripts/benchmarks/test-userinfo-benchmark.js
```

For Control Plane production-readiness checks, run UserInfo against a large seeded Core/PII dataset
within the tenant-assigned shard set and tag the tenant placement for analytics comparison:

```bash
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env TOKEN_PATH=../seeds/access_tokens.json \
  --env PRESET=rps500 \
  --env TENANT_PLACEMENT_POLICY=tenant_exclusive \
  --env DATASET_USER_COUNT=1000000 \
  scripts/benchmarks/test-userinfo-benchmark.js
```

### 2b. Run the deployed-env live-safe load check

If you want to exercise a real generated/deployed environment without relying on benchmark-only helpers, use:

```bash
pnpm exec tsx test/generated-environment/load-generated-live-safe.ts --env single --profile safe
pnpm exec tsx test/generated-environment/load-generated-live-safe.ts --config /path/to/.authrim/single/config.json --profile medium --json
```

This runner:

- uses supported public/admin/token/product APIs only
- bootstraps a real approval/grant/protected-resource context
- checks load, abuse, and concurrency behavior
- records latency, status mix, and `retry_after`
- is meant for resilience validation, not capacity sizing

### 2c. Run a Mac-local fixed-LPS check

When k6 Cloud/Grafana Cloud is not available, use the local Node runner. It is free, runs from this
Mac, and can check whether a generated environment survives a fixed local request rate.

```bash
pnpm setup:local-capacity -- --env single --scenario protected-resource --lps 100 --duration-seconds 30
pnpm setup:local-capacity -- --env single --scenario mixed --lps 150 --duration-seconds 30 --json
```

This is a regression and readiness check, not a replacement for distributed capacity testing:

- remote Cloudflare targets include home-network latency and one-client-IP behavior.
- local Wrangler/Miniflare targets include local runtime and D1/SQLite emulation overhead.
- 100/150 LPS can often be generated by a modern Mac for these API scenarios, but Full Login
  100/150 LPS remains authoritative only when run against a deployed Cloudflare environment with
  server-side Worker/D1/Durable Object metrics.

### 2d. Run a Mac-local synthetic user-scale check

For 1M-user and 10M-user data-volume checks without k6 Cloud/Grafana, run the SQLite-based local
benchmark. This checks query shapes and index/cardinality behavior rather than HTTP throughput.

```bash
# 1M users across 200 tenants, approximating shared consortium shape
pnpm setup:local-user-scale -- --env single --users 1000000 --tenant-count 200 --scenario mixed

# 1M users in one tenant, approximating a very large dedicated tenant
pnpm setup:local-user-scale -- --env single --users 1000000 --tenant-count 1 --scenario pii-search --fresh

# 10M-user index/cardinality rehearsal; expect more disk and runtime
pnpm setup:local-user-scale -- --config /path/to/.authrim/single/config.json --users 10000000 --tenant-count 200 --scenario domain-lookup --query-iterations 3
```

The output includes DB size, seed time, per-query average latency, and SQLite `EXPLAIN QUERY PLAN`.
`--env` and `--config` read generated setup metadata and lock D1 bindings. Treat the benchmark as a
local regression and query-shape signal; it does not include Cloudflare D1 remote latency, Worker
CPU, Durable Objects, or D1 platform limits.

### 3. Collect Cloudflare Analytics

```bash
# Fetch metrics for last 10 minutes
CF_API_TOKEN=xxx node scripts/utils/report-cf-analytics.js --minutes 10

# Fetch metrics for specific time range
CF_API_TOKEN=xxx node scripts/utils/report-cf-analytics.js \
  --start "2025-12-17T10:00:00Z" --end "2025-12-17T10:30:00Z"
```

---

## Available Benchmarks

Admin seed and setup calls require a short-lived Admin Machine Access token in
`ADMIN_MACHINE_ACCESS_TOKEN`. Issue it with explicit permissions for the Admin endpoints used by
the selected seed or benchmark, scope it to `TENANT_ID`, and start the run before it expires. Static
`ADMIN_API_SECRET` credentials are not supported.

| Benchmark           | Endpoint                     | Seed Script              | K6 Script                               |
| ------------------- | ---------------------------- | ------------------------ | --------------------------------------- |
| Token Introspection | `POST /introspect`           | `seed-access-tokens.js`  | `test-introspect-benchmark.js`          |
| Token Exchange      | `POST /token`                | `seed-access-tokens.js`  | `test-token-exchange-benchmark.js`      |
| UserInfo            | `GET /userinfo`              | `seed-access-tokens.js`  | `test-userinfo-benchmark.js`            |
| Silent Auth         | `GET /authorize?prompt=none` | `seed-otp-users.js`      | `test-authorize-silent-benchmark.js`    |
| Refresh Token       | `POST /token`                | `seed-refresh-tokens.js` | `test-refresh.js`                       |
| Audit-heavy Token   | `POST /token`                | `seed-refresh-tokens.js` | `test-audit-heavy-benchmark.js`         |
| Mail OTP Login      | 5-step OAuth flow            | `seed-otp-users.js`      | `test-mail-otp-full-login-benchmark.js` |
| Passkey Login       | 6-step OAuth flow            | `seed-passkey-users.js`  | `test-passkey-full-login-benchmark.js`  |
| SCIM Provisioning   | User create/get/lifecycle    | None                     | `test-scim-provisioning-benchmark.js`   |
| SCIM Scale Seed     | Controlled single-user POSTs | None                     | `test-scim-scale-provision.js`          |
| SCIM Bulk           | `POST /scim/v2/Bulk`         | None                     | `test-scim-bulk-benchmark.js`           |

### SCIM Provisioning

Use a dedicated, short-lived SCIM bearer token. The scripts do not print the token. Run the
single-resource lifecycle benchmark first, and only then increase Bulk throughput.

```bash
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env SCIM_TOKEN=... \
  --env TENANT_ID=default \
  --env TARGET_USERS=1000 \
  --env VUS=3 \
  scripts/benchmarks/test-scim-scale-provision.js

k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env SCIM_TOKEN=... \
  --env TENANT_ID=default \
  --env PRESET=smoke \
  scripts/benchmarks/test-scim-provisioning-benchmark.js

k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env SCIM_TOKEN=... \
  --env TENANT_ID=default \
  --env PRESET=smoke \
  --env BULK_SIZE=20 \
  scripts/benchmarks/test-scim-bulk-benchmark.js
```

Each run uses a unique `RUN_ID` by default. Set it explicitly when correlating a run with
Cloudflare Analytics. These benchmarks intentionally retain their provisioned users so that
post-run directory and lifecycle consistency can be inspected.

The Bulk benchmark defaults to a 30-second p95 and 60-second p99 request guardrail and fails when
the arrival-rate executor drops a batch. Override `P95_LIMIT_MS` and `P99_LIMIT_MS` when validating
an explicitly agreed environment SLO. `FAIL_ON_ERRORS=0` allows independent `/Users` creates to use
the server's bounded parallel path; non-zero values retain RFC stop-after-error sequencing.

Mapped SCIM attribute updates have separate PATCH benchmarks:

```bash
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env SCIM_TOKEN=... \
  --env TENANT_ID=default \
  --env PRESET=rps14 \
  --env POOL_SIZE=1000 \
  scripts/benchmarks/test-scim-attribute-update-benchmark.js

k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env SCIM_TOKEN=... \
  --env TENANT_ID=default \
  --env PRESET=rps30 \
  --env POOL_SIZE=2000 \
  --env BULK_SIZE=20 \
  scripts/benchmarks/test-scim-bulk-attribute-update-benchmark.js
```

The default update payload changes `displayName`, which is part of the Minimal SCIM mapping set.
Identifier changes (`userName` and primary email) use the durable identifier-replacement workflow
and should be benchmarked separately. Deep `startIndex` pool loading is setup work and is excluded
from update throughput; for repeated long runs, generate and reuse a dedicated user-ID pool.

### Token Introspection / Token Exchange / UserInfo

These benchmarks share the same seed data (access tokens).

```bash
# 1. Generate access tokens
BASE_URL=https://your-authrim.example.com \
CLIENT_ID=xxx CLIENT_SECRET=yyy ADMIN_MACHINE_ACCESS_TOKEN=zzz \
TOKEN_COUNT=3000 \
node scripts/seeds/seed-access-tokens.js

# 2. Run benchmark
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx --env CLIENT_SECRET=yyy \
  --env PRESET=rps300 \
  scripts/benchmarks/test-introspect-benchmark.js
```

### Silent Auth

```bash
# 1. Seed users
BASE_URL=https://your-authrim.example.com \
ADMIN_MACHINE_ACCESS_TOKEN=zzz OTP_USER_COUNT=500 \
node scripts/seeds/seed-otp-users.js

# 2. Run benchmark (sessions created in setup phase)
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx --env CLIENT_SECRET=yyy --env ADMIN_MACHINE_ACCESS_TOKEN=zzz \
  --env PRESET=rps200 \
  scripts/benchmarks/test-authorize-silent-benchmark.js
```

### Mail OTP Full Login

```bash
# 1. Seed OTP users
BASE_URL=https://your-authrim.example.com \
ADMIN_MACHINE_ACCESS_TOKEN=zzz OTP_USER_COUNT=500 \
node scripts/seeds/seed-otp-users.js

# 2. Run benchmark
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx --env CLIENT_SECRET=yyy --env ADMIN_MACHINE_ACCESS_TOKEN=zzz \
  --env PRESET=rps50 \
  scripts/benchmarks/test-mail-otp-full-login-benchmark.js
```

### Transient Authentication State Verification

Use the Mail OTP Full Login benchmark to verify ChallengeStore, SessionStore, AuthCodeStore,
RefreshTokenRotator, SessionRevocationStore, and the `/authorize` and `/token` paths. The Control
Plane runtime policy is fixed: session and Device/CIBA cold D1 persistence are disabled, so the
benchmark does not expose a mirror-mode switch.

```bash
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx --env CLIENT_SECRET=yyy --env ADMIN_MACHINE_ACCESS_TOKEN=zzz \
  --env PRESET=rps100 \
  --env TENANT_PLACEMENT_POLICY=tenant_exclusive \
  scripts/benchmarks/test-mail-otp-full-login-benchmark.js
```

For the comparison report, record `authorize_code_latency`, `token_latency`, `full_flow_latency`,
D1 write/read counts by binding, Durable Object request counts, and queue retry/backlog metrics if
audit sinks are enabled. Confirm that no session or Device/CIBA cold-mirror D1 statements appear.

### Audit-heavy Token Activity

Use this when comparing D1-primary audit profiles against queue/R2/archive-oriented audit
profiles. The benchmark intentionally avoids replay/theft cases so seeded refresh-token families
remain reusable.

```bash
# 1. Generate refresh-token families
BASE_URL=https://your-authrim.example.com \
CLIENT_ID=xxx CLIENT_SECRET=yyy ADMIN_MACHINE_ACCESS_TOKEN=zzz COUNT=2000 \
node scripts/seeds/seed-refresh-tokens.js

# 2. Run audit-heavy benchmark
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx --env CLIENT_SECRET=yyy \
  --env PRESET=rps100 \
  scripts/benchmarks/test-audit-heavy-benchmark.js
```

Compare Cloudflare Analytics D1 read/write counts, `AUDIT_QUEUE` backlog/retries, and R2 object
writes between audit profiles after each run.

### Passkey Full Login

> **⚠️ Note (Jan 2026)**: The xk6-passkeys extension previously located at `extensions/xk6-passkeys/` has been removed due to 66 security vulnerabilities in its Go dependencies (go@1.23.0) with no available fixes. The extension was a fork of [corbado/xk6-passkeys](https://github.com/corbado/xk6-passkeys) with added `ImportCredential` support for credential serialization in k6's setup/teardown phases.
>
> **For future passkey load testing**:
>
> - Use the upstream [corbado/xk6-passkeys](https://github.com/corbado/xk6-passkeys) extension directly
> - Or rebuild from the [descope/virtualwebauthn](https://github.com/descope/virtualwebauthn) library
> - Original implementation: `passkeys.go` with iCloud Keychain AAGUID (`fbfc3007-154e-4ecc-8c0b-6e020557d7bd`)

**Previous setup** (for reference):

```bash
# 1. Build custom K6 (requires Go 1.23+)
./scripts/utils/build-k6-passkeys.sh

# 2. Seed passkey users
BASE_URL=https://your-authrim.example.com \
ADMIN_MACHINE_ACCESS_TOKEN=zzz PASSKEY_USER_COUNT=100 \
node scripts/seeds/seed-passkey-users.js

# 3. Run benchmark
./bin/k6-passkeys run \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx --env CLIENT_SECRET=yyy --env ADMIN_MACHINE_ACCESS_TOKEN=zzz \
  --env PRESET=rps30 \
  scripts/benchmarks/test-passkey-full-login-benchmark.js
```

### K6 Cloud Execution

For distributed load testing, use K6 Cloud with `*-cloud.js` scripts:

```bash
k6 cloud \
  --env BASE_URL=https://your-authrim.example.com \
  --env TOKEN_URL=https://your-r2-bucket.example.com/seeds/tokens.json \
  --env PRESET=rps500 \
  scripts/benchmarks/test-userinfo-benchmark-cloud.js
```

---

## Seed Scripts

All seed scripts are in `scripts/seeds/`. Create a test client first via Admin API.

### Create Test Client

```bash
curl -X POST "https://your-authrim.example.com/api/admin/clients" \
  -H "Authorization: Bearer YOUR_ADMIN_MACHINE_ACCESS_TOKEN" \
  -H "X-Tenant-Id: default" \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Load Test Client",
    "redirect_uris": ["https://localhost:3000/callback"],
    "grant_types": ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:token-exchange"],
    "scope": "openid profile email",
    "skip_consent": true,
    "token_exchange_allowed": true
  }'
```

### Script Reference

| Script                   | Required Env Vars                                                      | Optional                                                                | Description                             |
| ------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| `seed-access-tokens.js`  | `BASE_URL`, `CLIENT_ID`, `CLIENT_SECRET`, `ADMIN_MACHINE_ACCESS_TOKEN` | `TENANT_ID` (`default`), `TOKEN_COUNT` (1000), `CONCURRENCY` (20)       | Tokens for introspect/exchange/userinfo |
| `seed-otp-users.js`      | `BASE_URL`, `ADMIN_MACHINE_ACCESS_TOKEN`                               | `TENANT_ID` (`default`), `OTP_USER_COUNT` (500), `CONCURRENCY` (20)     | Users for OTP login / silent auth       |
| `seed-passkey-users.js`  | `BASE_URL`, `ADMIN_MACHINE_ACCESS_TOKEN`                               | `TENANT_ID` (`default`), `PASSKEY_USER_COUNT` (100), `CONCURRENCY` (10) | Users with passkey credentials          |
| `seed-refresh-tokens.js` | `BASE_URL`, `CLIENT_ID`, `CLIENT_SECRET`, `ADMIN_MACHINE_ACCESS_TOKEN` | `TENANT_ID` (`default`), `COUNT` (120)                                  | Refresh tokens for rotation tests       |
| `seed-authcodes.js`      | `BASE_URL`, `CLIENT_ID`, `CLIENT_SECRET`, `ADMIN_MACHINE_ACCESS_TOKEN` | `TENANT_ID` (`default`), `AUTH_CODE_COUNT` (200)                        | Authorization codes                     |

**Token Mix** (`seed-access-tokens.js`): Valid 60%, Token Exchange 5%, Expired 12%, Revoked 12%, Wrong Audience 6%, Wrong Client 5%

Notes:

- Even in a single-tenant generated environment such as `single`, admin seed APIs still require
  `X-Tenant-Id: default`.
- The seed scripts above now accept `TENANT_ID` and attach that header automatically.

---

## Reports

Detailed load test reports with performance analysis:

- [SCIM Attribute Update Benchmark](./reports/Aug2026/scim-attribute-update.md)
- [Silent Auth Benchmark](./reports/Dec2025/silent-auth.md)
- [UserInfo Benchmark](./reports/Dec2025/userinfo.md)
- [Token Exchange Benchmark](./reports/Dec2025/token-exchange.md)
- [Token Introspection Benchmark](./reports/Dec2025/token-introspection.md)
- [Refresh Token Rotation Benchmark](./reports/Dec2025/refresh-token.md)
- [Full Login (Mail OTP) Benchmark](./reports/Dec2025/full-login-otp.md)

See [Reports Index](./reports/Dec2025/README.md) for performance summary across all benchmarks.

---

## Directory Structure

```
load-testing/
├── README.md
├── reports/
│   ├── Aug2026/
│   │   └── scim-attribute-update.md  # SCIM update capacity report
│   └── Dec2025/                    # OIDC load test reports
│       ├── README.md               # Performance summary
│       ├── silent-auth.md
│       ├── userinfo.md
│       ├── token-exchange.md
│       ├── token-introspection.md
│       ├── refresh-token.md
│       └── full-login-otp.md
└── scripts/
    ├── benchmarks/                 # K6 benchmark scripts
    │   ├── test-authorize-silent-benchmark.js
    │   ├── test-authorize-silent-benchmark-cloud.js
    │   ├── test-userinfo-benchmark.js
    │   ├── test-userinfo-benchmark-cloud.js
    │   ├── test-token-exchange-benchmark.js
    │   ├── test-token-exchange-benchmark-cloud.js
    │   ├── test-introspect-benchmark.js
    │   ├── test-introspect-benchmark-cloud.js
    │   ├── test-mail-otp-full-login-benchmark.js
    │   ├── test-mail-otp-full-login-benchmark-cloud.js
    │   ├── test-passkey-full-login-benchmark.js
    │   ├── test-passkey-full-login-benchmark-vm.js
    │   └── test-refresh.js
    ├── seeds/                      # Seed data generation
    │   ├── seed-access-tokens.js
    │   ├── seed-authcodes.js
    │   ├── seed-otp-users.js
    │   ├── seed-passkey-users.js
    │   └── seed-refresh-tokens.js
    └── utils/                      # Utilities
        ├── build-k6-passkeys.sh
        └── report-cf-analytics.js
```
