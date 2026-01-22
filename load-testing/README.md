# Authrim Load Testing

Load testing framework for Authrim OIDC Provider using K6.

> **See also**: [Testing Guide](../docs/getting-started/testing.md) for unit tests, E2E tests, conformance tests, and other test types.

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
- **Full Login Flows** - Complete OAuth flows with Mail OTP or Passkey

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

| Benchmark           | Endpoint                     | Seed Script              | K6 Script                               |
| ------------------- | ---------------------------- | ------------------------ | --------------------------------------- |
| Token Introspection | `POST /introspect`           | `seed-access-tokens.js`  | `test-introspect-benchmark.js`          |
| Token Exchange      | `POST /token`                | `seed-access-tokens.js`  | `test-token-exchange-benchmark.js`      |
| UserInfo            | `GET /userinfo`              | `seed-access-tokens.js`  | `test-userinfo-benchmark.js`            |
| Silent Auth         | `GET /authorize?prompt=none` | `seed-otp-users.js`      | `test-authorize-silent-benchmark.js`    |
| Refresh Token       | `POST /token`                | `seed-refresh-tokens.js` | `test-refresh.js`                       |
| Mail OTP Login      | 5-step OAuth flow            | `seed-otp-users.js`      | `test-mail-otp-full-login-benchmark.js` |
| Passkey Login       | 6-step OAuth flow            | `seed-passkey-users.js`  | `test-passkey-full-login-benchmark.js`  |

### Token Introspection / Token Exchange / UserInfo

These benchmarks share the same seed data (access tokens).

```bash
# 1. Generate access tokens
BASE_URL=https://your-authrim.example.com \
CLIENT_ID=xxx CLIENT_SECRET=yyy ADMIN_API_SECRET=zzz \
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
ADMIN_API_SECRET=zzz OTP_USER_COUNT=500 \
node scripts/seeds/seed-otp-users.js

# 2. Run benchmark (sessions created in setup phase)
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx --env CLIENT_SECRET=yyy --env ADMIN_API_SECRET=zzz \
  --env PRESET=rps200 \
  scripts/benchmarks/test-authorize-silent-benchmark.js
```

### Mail OTP Full Login

```bash
# 1. Seed OTP users
BASE_URL=https://your-authrim.example.com \
ADMIN_API_SECRET=zzz OTP_USER_COUNT=500 \
node scripts/seeds/seed-otp-users.js

# 2. Run benchmark
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx --env CLIENT_SECRET=yyy --env ADMIN_API_SECRET=zzz \
  --env PRESET=rps50 \
  scripts/benchmarks/test-mail-otp-full-login-benchmark.js
```

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
ADMIN_API_SECRET=zzz PASSKEY_USER_COUNT=100 \
node scripts/seeds/seed-passkey-users.js

# 3. Run benchmark
./bin/k6-passkeys run \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx --env CLIENT_SECRET=yyy --env ADMIN_API_SECRET=zzz \
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
  -H "Authorization: Bearer YOUR_ADMIN_API_SECRET" \
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

| Script                   | Required Env Vars                                            | Optional                                       | Description                             |
| ------------------------ | ------------------------------------------------------------ | ---------------------------------------------- | --------------------------------------- |
| `seed-access-tokens.js`  | `BASE_URL`, `CLIENT_ID`, `CLIENT_SECRET`, `ADMIN_API_SECRET` | `TOKEN_COUNT` (1000), `CONCURRENCY` (20)       | Tokens for introspect/exchange/userinfo |
| `seed-otp-users.js`      | `BASE_URL`, `ADMIN_API_SECRET`                               | `OTP_USER_COUNT` (500), `CONCURRENCY` (20)     | Users for OTP login / silent auth       |
| `seed-passkey-users.js`  | `BASE_URL`, `ADMIN_API_SECRET`                               | `PASSKEY_USER_COUNT` (100), `CONCURRENCY` (10) | Users with passkey credentials          |
| `seed-refresh-tokens.js` | `BASE_URL`, `CLIENT_ID`, `CLIENT_SECRET`, `ADMIN_API_SECRET` | `COUNT` (120)                                  | Refresh tokens for rotation tests       |
| `seed-authcodes.js`      | `BASE_URL`, `CLIENT_ID`, `CLIENT_SECRET`, `ADMIN_API_SECRET` | `AUTH_CODE_COUNT` (200)                        | Authorization codes                     |

**Token Mix** (`seed-access-tokens.js`): Valid 60%, Token Exchange 5%, Expired 12%, Revoked 12%, Wrong Audience 6%, Wrong Client 5%

---

## Reports

Detailed load test reports with performance analysis:

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
│   └── Dec2025/                    # Load test reports
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
