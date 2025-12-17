# Authrim Load Testing Specification

Load testing presets for Authrim, targeting home and semi-commercial use cases.

## Table of Contents

- [Overview](#overview)
- [Performance Benchmarks](#performance-benchmarks)
- [Test Environment Architecture](#test-environment-architecture)
- [Quick Start](#quick-start)
- [Available Benchmarks](#available-benchmarks)
- [Distributed Load Testing](#distributed-load-testing-test-4)
- [Passkey Full Login Benchmark](#passkey-full-login-benchmark)
- [Directory Structure](#directory-structure)
- [Seed Scripts Reference](#seed-scripts-reference)
- [Reports](#reports)
- [Collected Metrics](#collected-metrics)

---

## Performance Benchmarks

> Tested with distributed load across multiple OAuth clients (realistic multi-tenant simulation)

### MAU Capacity

| Target MAU | Peak RPS | Clients | p95 Latency | p99 Latency | Success Rate | Token Rotation |
| ---------- | -------- | ------- | ----------- | ----------- | ------------ | -------------- |
| 100K       | 20 RPS   | 10      | TBD         | TBD         | TBD          | TBD            |
| 500K       | 100 RPS  | 20      | TBD         | TBD         | TBD          | TBD            |
| 1M         | 200 RPS  | 30      | TBD         | TBD         | TBD          | TBD            |
| 2M         | 400 RPS  | 40      | TBD         | TBD         | TBD          | TBD            |

> **Note**: Run `node scripts/generate-report.js` after load tests to update these values.

### Key Metrics Explained

- **Peak RPS**: Requests per second during peak load (refresh token operations)
- **p95/p99 Latency**: 95th/99th percentile response time
- **Success Rate**: Percentage of successful requests (>99.9% target)
- **Token Rotation**: Successful refresh token rotation rate (>99% target)

### MAU to RPS Conversion

```
RPS_peak = (MAU × DAU_Ratio × Requests_Per_DAU) / (Active_Hours × 3600) × Peak_Factor
        ≈ MAU / 5,000
```

**Default Parameters:**

| Parameter        | Value | Rationale                      |
| ---------------- | ----- | ------------------------------ |
| DAU/MAU Ratio    | 20%   | B2B SaaS industry standard     |
| Logins/Day       | 1.5   | Business application typical   |
| Refreshes/Day    | 8     | 1-hour access token assumption |
| Requests/Login   | 3.1   | authorize + token + userinfo   |
| Requests/Refresh | 1.2   | token + occasional userinfo    |
| Peak Factor      | 2.0x  | Industry benchmark             |
| Active Hours     | 8     | Business hours                 |

---

## Overview

The purpose of this test framework is:

1. **Measure actual RPS capacity of current Authrim architecture (Worker + DO + KV + D1)**
2. **Provide realistic presets from light to heavy load, reproducible in home environment**
3. **Collect actual CPU, memory, and request statistics from Cloudflare Analytics API / Graph API via wrangler after tests**
4. **All executable with k6 OSS and home fiber internet / MacBook / Mac mini**

## Test Environment Architecture

### Test Execution Environment (Local)

- **Machine**: macOS (M1/M2/M3)
- **Internet**: Standard home fiber with 50-200Mbps upload
- **Required Tools**:
  - [k6 OSS](https://k6.io/)
  - [wrangler](https://developers.cloudflare.com/workers/wrangler/)
  - jq (optional, for result formatting)

### Authrim Architecture

```mermaid
flowchart TB
    subgraph Local["Local Environment"]
        k6["k6 (Local)"]
    end

    subgraph CF["Cloudflare"]
        Edge["Cloudflare Edge"]

        subgraph Worker["Authrim Worker"]
            W["Worker + KeyManager (cache)"]
        end

        subgraph Storage["Storage Layer"]
            KV["KV (JWK)"]
            DO1["DO: AuthorizationCodeStore"]
            DO2["DO: TokenRotator"]
            D1["D1: token/session storage"]
        end
    end

    k6 --> Edge
    Edge --> W
    W --> KV
    W --> DO1
    W --> DO2
    W --> D1
```


## Test Presets

### TEST 1: /token Endpoint Load Test

Measures peak tolerance of authentication flow.

| Preset       | RPS       | Duration | VUs     | Expected                   |
| ------------ | --------- | -------- | ------- | -------------------------- |
| **Light**    | 5 → 20    | 60s      | 20      | p99 < 250ms                |
| **Standard** | 30 → 100  | 120s     | 100     | p99 < 500ms                |
| **Heavy**    | 200 → 600 | 180s     | 200-600 | Measure 429/500 error rate |

### TEST 2: Refresh Token Storm

Measures real-world maximum traffic handling.

| Preset       | RPS      | Duration | Expected                   |
| ------------ | -------- | -------- | -------------------------- |
| **Light**    | 50       | 5min     | p99 < 300ms                |
| **Standard** | 200-500  | 10min    | error rate < 0.1%          |
| **Heavy**    | 800-1200 | 10min    | Measure DO lock contention |

### TEST 3: Full OIDC Authentication Flow

Workload closest to real service usage.

| Preset       | RPS    | Duration | Expected                        |
| ------------ | ------ | -------- | ------------------------------- |
| **Light**    | 10-20  | 120s     | p99 < 300ms                     |
| **Standard** | 30-50  | 180s     | p99 < 500ms                     |
| **Heavy**    | 80-100 | 180s     | Measure latency spike threshold |


## Quick Start

### 1. Environment Setup

```bash
# Install k6 (macOS)
brew install k6

# Install wrangler
npm install -g wrangler

# Login to wrangler
wrangler login
```

### 2. Configure Target Environment

Create `.env` file:

```bash
cp .env.example .env
```

Configure the following:

```env
# Target Authrim Worker URL
BASE_URL=https://your-authrim.example.com

# Test client credentials
CLIENT_ID=test_client_id
CLIENT_SECRET=test_client_secret

# Cloudflare settings (for metrics collection)
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_api_token
```

### 3. Run Tests

```bash
# Run benchmark (example: UserInfo with rps100 preset)
k6 run \
  --env PRESET=rps100 \
  --env BASE_URL=https://your-authrim.example.com \
  --env TOKEN_URL=https://your-r2-bucket.example.com/seeds/tokens.json \
  scripts/benchmarks/test-userinfo-benchmark.js

# Run on K6 Cloud
k6 cloud \
  --env PRESET=rps500 \
  --env BASE_URL=https://your-authrim.example.com \
  --env TOKEN_URL=https://your-r2-bucket.example.com/seeds/tokens.json \
  scripts/benchmarks/test-userinfo-benchmark-cloud.js
```

### 4. Collect Cloudflare Analytics

```bash
# Fetch metrics from Cloudflare Analytics (last 10 minutes)
CF_API_TOKEN=xxx CF_ACCOUNT_ID=yyy node scripts/utils/report-cf-analytics.js --minutes 10

# Fetch metrics for specific time range
CF_API_TOKEN=xxx CF_ACCOUNT_ID=yyy node scripts/utils/report-cf-analytics.js \
  --start "2025-12-17T10:00:00Z" --end "2025-12-17T10:30:00Z"
```

---

## Available Benchmarks

Each benchmark requires specific seed data. Follow the quick start guide for each benchmark.

### Benchmark Overview

| Benchmark | Endpoint | Seed Script | Description |
|-----------|----------|-------------|-------------|
| **Token Introspection** | `POST /introspect` | `seed-access-tokens.js` | RFC 7662 token validation |
| **Token Exchange** | `POST /token` | `seed-access-tokens.js` | RFC 8693 token exchange |
| **UserInfo** | `GET /userinfo` | `seed-access-tokens.js` | OIDC UserInfo endpoint |
| **Silent Auth** | `GET /authorize?prompt=none` | Admin API (sessions) | SSO silent authentication |
| **Mail OTP Full Login** | 5-step OAuth flow | `seed-otp-users.js` | Complete login with email OTP |
| **Passkey Full Login** | 6-step OAuth flow | `seed-passkey-users.js` | Complete login with WebAuthn |

### Quick Start: Token Introspection / Token Exchange / UserInfo

These benchmarks share the same seed data (access tokens).

```bash
cd load-testing

# 1. Generate access tokens (3,000 tokens with mixed types)
BASE_URL=https://your-authrim.example.com \
CLIENT_ID=xxx \
CLIENT_SECRET=yyy \
ADMIN_API_SECRET=zzz \
TOKEN_COUNT=3000 \
node scripts/seeds/seed-access-tokens.js

# 2. Run Token Introspection benchmark
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx \
  --env CLIENT_SECRET=yyy \
  --env PRESET=rps300 \
  scripts/benchmarks/test-introspect-benchmark.js

# 3. Run Token Exchange benchmark
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx \
  --env CLIENT_SECRET=yyy \
  --env PRESET=rps100 \
  scripts/benchmarks/test-token-exchange-benchmark.js

# 4. Run UserInfo benchmark
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env PRESET=rps500 \
  scripts/benchmarks/test-userinfo-benchmark.js
```

### Quick Start: Silent Authentication

```bash
cd load-testing

# 1. Seed users first (creates test users via Admin API)
BASE_URL=https://your-authrim.example.com \
ADMIN_API_SECRET=zzz \
OTP_USER_COUNT=500 \
node scripts/seeds/seed-otp-users.js

# 2. Run Silent Auth benchmark (sessions are created in setup phase)
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx \
  --env CLIENT_SECRET=yyy \
  --env ADMIN_API_SECRET=zzz \
  --env PRESET=rps200 \
  scripts/benchmarks/test-authorize-silent-benchmark.js
```

### Quick Start: Mail OTP Full Login

```bash
cd load-testing

# 1. Seed OTP users
BASE_URL=https://your-authrim.example.com \
ADMIN_API_SECRET=zzz \
OTP_USER_COUNT=500 \
node scripts/seeds/seed-otp-users.js

# 2. Run Mail OTP Full Login benchmark
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx \
  --env CLIENT_SECRET=yyy \
  --env ADMIN_API_SECRET=zzz \
  --env PRESET=rps50 \
  scripts/benchmarks/test-mail-otp-full-login-benchmark.js
```

### Quick Start: Passkey Full Login

Requires custom k6 binary with xk6-passkeys extension. See [Passkey Full Login Benchmark](#passkey-full-login-benchmark) section for detailed instructions.

```bash
cd load-testing

# 1. Build custom k6 binary (requires Go 1.23+)
./scripts/utils/build-k6-passkeys.sh

# 2. Seed Passkey users
BASE_URL=https://your-authrim.example.com \
ADMIN_API_SECRET=zzz \
PASSKEY_USER_COUNT=100 \
node scripts/seeds/seed-passkey-users.js

# 3. Run Passkey Full Login benchmark
./bin/k6-passkeys run \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx \
  --env CLIENT_SECRET=yyy \
  --env ADMIN_API_SECRET=zzz \
  --env PRESET=rps30 \
  scripts/benchmarks/test-passkey-full-login-benchmark.js
```

---

## Distributed Load Testing (TEST 4)

TEST 4 simulates realistic multi-tenant production environments by distributing load across multiple OAuth clients.

### Why Distributed Testing?

- **RefreshTokenRotator DO**: Sharded by `client_id` - single client testing measures worst-case scenario
- **Production Reality**: Multiple tenants (clients) with varying load levels
- **Realistic Benchmarks**: Weighted distribution matches real-world usage patterns

### Client Distribution

| Load Level | Share | Example (100 RPS)  | Description               |
| ---------- | ----- | ------------------ | ------------------------- |
| High       | 45%   | 3 clients × 15 RPS | Large enterprise tenants  |
| Medium     | 35%   | 7 clients × 5 RPS  | Mid-size business tenants |
| Low        | 20%   | 10 clients × 2 RPS | Small/individual tenants  |

### Quick Start for TEST 4

```bash
cd load-testing/scripts

# 1. Create test clients (20 clients for 100 RPS target)
ADMIN_API_SECRET=xxx TARGET_RPS=100 node setup-test-clients.js

# 2. Generate distributed seeds (refresh tokens for each client)
ADMIN_API_SECRET=xxx TEST_DURATION=600 node generate-distributed-seeds.js

# 3. Run distributed load test
cd .. && k6 run --env MAU_PRESET=mau-500k scripts/test4-distributed-load.js

# 4. Generate performance report
node scripts/generate-report.js

# 5. Cleanup (after testing)
ADMIN_API_SECRET=xxx node scripts/cleanup-test-clients.js
```

### Available MAU Presets

| Preset     | MAU  | Target RPS | Clients | Duration |
| ---------- | ---- | ---------- | ------- | -------- |
| `mau-100k` | 100K | 20 RPS     | 10      | 5 min    |
| `mau-500k` | 500K | 100 RPS    | 20      | 10 min   |
| `mau-1m`   | 1M   | 200 RPS    | 30      | 10 min   |
| `mau-2m`   | 2M   | 400 RPS    | 40      | 10 min   |

### Generated Reports

After running `generate-report.js`:

```
results/reports/
├── performance-report-YYYY-MM-DD.html  # Interactive HTML with charts
├── performance-report-YYYY-MM-DD.md    # Markdown for README
├── performance-report-YYYY-MM-DD.csv   # Raw data export
├── report.html                         # Latest report link
└── summary.md                          # Latest summary link
```

---

## Passkey Full Login Benchmark

Measures the full Passkey authentication flow including WebAuthn signature verification.

### Why Custom k6 Binary?

Standard k6 doesn't support ECDSA P-256 signature generation required for WebAuthn authentication.
This test uses the [xk6-passkeys](https://github.com/corbado/xk6-passkeys) extension to generate
valid WebAuthn assertion responses.

### Prerequisites

- **Go 1.23+** (required for building custom k6)
- Standard k6 test environment (same as other tests)

### Building Custom k6 Binary

```bash
cd load-testing

# Build k6 with passkeys extension
./scripts/build-k6-passkeys.sh

# Verify build
./bin/k6-passkeys version
```

### Running Passkey Benchmark

```bash
# Run with default preset (rps30)
./bin/k6-passkeys run \
  --env BASE_URL=https://your-authrim.example.com \
  --env ADMIN_API_SECRET=xxx \
  --env CLIENT_ID=xxx \
  --env CLIENT_SECRET=xxx \
  scripts/test-passkey-full-login-benchmark.js

# Run with specific preset
./bin/k6-passkeys run \
  --env PRESET=rps50 \
  --env BASE_URL=https://your-authrim.example.com \
  --env ADMIN_API_SECRET=xxx \
  --env CLIENT_ID=xxx \
  --env CLIENT_SECRET=xxx \
  scripts/test-passkey-full-login-benchmark.js
```

### Available Presets

| Preset   | RPS     | Duration | Users | Description        |
| -------- | ------- | -------- | ----- | ------------------ |
| `rps10`  | 10 RPS  | 30s      | 50    | Smoke test         |
| `rps30`  | 30 RPS  | 2 min    | 100   | Standard benchmark |
| `rps50`  | 50 RPS  | 3 min    | 150   | High throughput    |
| `rps100` | 100 RPS | 3 min    | 200   | Stress test        |
| `rps200` | 200 RPS | 3 min    | 300   | Maximum capacity   |

### Test Flow

```
setup() [Not included in benchmark metrics]:
  1. Create users via Admin API
  2. Generate passkey credentials (ECDSA P-256)
  3. Register passkeys with server

default() [Benchmark target - metrics collected]:
  1. GET /authorize (init)
  2. POST /api/auth/passkey/login/options (get challenge)
  3. Generate WebAuthn assertion (with valid signature)
  4. POST /api/auth/passkey/login/verify (authenticate)
  5. GET /authorize (get authorization code)
  6. POST /token (exchange code for tokens)
```

### Key Metrics

| Metric                   | Description                          |
| ------------------------ | ------------------------------------ |
| `passkey_verify_latency` | Passkey authentication response time |
| `authorize_code_latency` | Authorization code generation time   |
| `token_latency`          | Token endpoint response time         |
| `full_flow_latency`      | Complete login flow time             |
| `flow_success`           | Overall success rate                 |

### Important Notes

- **Custom binary required**: Standard `k6` command will fail with import error
- **Setup time**: User registration in setup() may take several seconds/minutes
- **Admin API required**: ADMIN_API_SECRET is required for user creation

### VM Execution (for Fair Comparison with Mail OTP)

k6 Cloud doesn't support custom extensions (xk6-passkeys). To compare Passkey with Mail OTP benchmarks fairly, run from a US region VM (same region as k6 Cloud's Portland load zone).

#### Why VM?

| Approach | Pros | Cons |
|----------|------|------|
| **Local (Mac)** | Easy setup | Japan→US latency adds ~150ms, unfair comparison |
| **k6 Cloud** | Same infra as Mail OTP | Custom extensions not supported |
| **US VM** | Same region as k6 Cloud, fair comparison | Requires VM setup |

#### VM Setup (AWS us-west-2 or GCP us-west1)

```bash
# 1. Create VM in US West region
#    - AWS: us-west-2 (Oregon) - closest to k6 Cloud Portland
#    - GCP: us-west1 (Oregon)
#    - Recommended: t3.medium / e2-medium or larger

# 2. SSH into VM and install Go 1.23+
wget https://go.dev/dl/go1.23.0.linux-amd64.tar.gz
sudo tar -C /usr/local -xzf go1.23.0.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
source ~/.bashrc

# Verify Go installation
go version  # Should show go1.23.0 or later

# 3. Clone repository and build custom k6
git clone https://github.com/your-org/authrim.git
cd authrim/load-testing
./scripts/build-k6-passkeys.sh

# Verify build
./bin/k6-passkeys version
# Should show: k6-passkeys vX.X.X with extension k6/x/passkeys

# 4. Create .env file with credentials
cat > .env << 'EOF'
BASE_URL=https://your-authrim.example.com
ADMIN_API_SECRET=your-admin-secret
CLIENT_ID=your-client-id
CLIENT_SECRET=your-client-secret
EOF
```

#### Quick Start (Recommended)

```bash
# All-in-one: Seed users + Run benchmark
./scripts/run-passkey-benchmark-vm.sh all rps50
```

#### Step-by-Step Execution

```bash
# Step 1: Seed passkey users (creates users and saves credentials)
# This only needs to be done once per test session
./scripts/run-passkey-benchmark-vm.sh seed

# Output: ./seeds/passkey_credentials_vm.json

# Step 2: Run benchmark with desired preset
./scripts/run-passkey-benchmark-vm.sh benchmark rps50

# Available presets: rps10, rps50, rps100, rps125, rps150, rps200
```

#### Manual Execution (Advanced)

```bash
# Seed mode - creates users and exports credentials to JSON
./bin/k6-passkeys run \
  --env MODE=seed \
  --env BASE_URL=https://your-authrim.example.com \
  --env ADMIN_API_SECRET=xxx \
  --env PASSKEY_USER_COUNT=500 \
  scripts/test-passkey-full-login-benchmark-vm.js 2>&1 | ./scripts/extract-credentials.sh

# Benchmark mode - uses pre-seeded credentials (pure login benchmark)
./bin/k6-passkeys run \
  --env MODE=benchmark \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx \
  --env CLIENT_SECRET=xxx \
  --env PRESET=rps125 \
  --env CREDENTIAL_FILE=./seeds/passkey_credentials_vm.json \
  scripts/test-passkey-full-login-benchmark-vm.js
```

#### VM Presets (Matching Mail OTP)

| Preset | Target RPS | Duration | Seed Users | Comparison Target |
|--------|------------|----------|------------|-------------------|
| `rps10` | 10 RPS | 30s | 100 | Smoke test |
| `rps50` | 50 RPS | 2 min | 500 | Mail OTP 50 LPS |
| `rps100` | 100 RPS | 2 min | 1000 | Mail OTP 100 LPS |
| `rps125` | 125 RPS | 2 min | 1250 | Mail OTP 125 LPS |
| `rps150` | 150 RPS | 2 min | 1500 | Mail OTP 150 LPS |
| `rps200` | 200 RPS | 3 min | 2000 | Stress test |

#### Two-Mode Design

The VM script uses a two-mode design for accurate benchmarking:

```
MODE=seed (Preparation - not measured):
  ┌─────────────────────────────────────────────────────┐
  │ 1. Create user via Admin API                        │
  │ 2. Generate ECDSA P-256 keypair (xk6-passkeys)      │
  │ 3. Register passkey with server                     │
  │ 4. Export credential to JSON                        │
  └─────────────────────────────────────────────────────┘
                          ↓
            seeds/passkey_credentials_vm.json
                          ↓
MODE=benchmark (Measured - pure login flow):
  ┌─────────────────────────────────────────────────────┐
  │ 1. Import credential from JSON                      │
  │ 2. GET /authorize (init)                            │
  │ 3. POST /api/auth/passkey/login/options             │
  │ 4. Generate WebAuthn assertion (signature)          │
  │ 5. POST /api/auth/passkey/login/verify              │
  │ 6. GET /authorize (get code)                        │
  │ 7. POST /token                                      │
  └─────────────────────────────────────────────────────┘
```

This matches the Mail OTP benchmark pattern where users are pre-seeded.

---

## Directory Structure

```
load-testing/
├── README.md                          # This file
├── extensions/                        # Custom k6 extensions
│   └── xk6-passkeys/                  # Forked xk6-passkeys with Import/Export
├── reports/                           # Load test reports
│   └── Dec2025/                       # December 2025 test results
│       ├── README.md                  # Performance summary
│       ├── silent-auth.md             # Silent Auth benchmark
│       ├── userinfo.md                # UserInfo benchmark
│       ├── token-exchange.md          # Token Exchange benchmark
│       ├── token-introspection.md     # Token Introspection benchmark
│       └── full-login-otp.md          # Full Login (Mail OTP) benchmark
└── scripts/
    ├── benchmarks/                    # k6 benchmark scripts
    │   ├── test-authorize-silent-benchmark.js      # Silent Auth (local)
    │   ├── test-authorize-silent-benchmark-cloud.js # Silent Auth (K6 Cloud)
    │   ├── test-userinfo-benchmark.js              # UserInfo (local)
    │   ├── test-userinfo-benchmark-cloud.js        # UserInfo (K6 Cloud)
    │   ├── test-token-exchange-benchmark.js        # Token Exchange (local)
    │   ├── test-token-exchange-benchmark-cloud.js  # Token Exchange (K6 Cloud)
    │   ├── test-introspect-benchmark.js            # Token Introspection (local)
    │   ├── test-introspect-benchmark-cloud.js      # Token Introspection (K6 Cloud)
    │   ├── test-mail-otp-full-login-benchmark.js   # Full Login Mail OTP (local)
    │   ├── test-mail-otp-full-login-benchmark-cloud.js # Full Login Mail OTP (K6 Cloud)
    │   ├── test-passkey-full-login-benchmark.js    # Passkey Login (local)
    │   ├── test-passkey-full-login-benchmark-vm.js # Passkey Login (VM)
    │   └── test-refresh.js                         # Refresh Token
    ├── seeds/                         # Seed data generation scripts
    │   ├── seed-access-tokens.js      # Generate access tokens for introspection
    │   ├── seed-authcodes.js          # Generate authorization codes
    │   ├── seed-otp-users.js          # Generate OTP users
    │   ├── seed-passkey-users.js      # Generate Passkey users
    │   └── seed-refresh-tokens.js     # Generate refresh tokens
    └── utils/                         # Utility scripts
        ├── build-k6-passkeys.sh       # Build k6 with passkeys extension
        └── report-cf-analytics.js     # Cloudflare Analytics reporter
```

---

## Seed Scripts Reference

Each benchmark requires specific seed data. All seed scripts are located in `scripts/seeds/`.

### Prerequisites: Create Test Client

Before running seed scripts, create a test client via Admin API:

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

### seed-access-tokens.js

Generates access tokens for Token Introspection, Token Exchange, and UserInfo benchmarks.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BASE_URL` | **Yes** | - | Target Authrim Worker URL |
| `CLIENT_ID` | **Yes** | - | OAuth client ID |
| `CLIENT_SECRET` | **Yes** | - | OAuth client secret |
| `ADMIN_API_SECRET` | **Yes** | - | Admin API Bearer token |
| `TOKEN_COUNT` | No | `1000` | Total tokens to generate |
| `CONCURRENCY` | No | `20` | Parallel requests |

**Token Mix**: Valid 60%, Token Exchange 5%, Expired 12%, Revoked 12%, Wrong Audience 6%, Wrong Client 5%

### seed-otp-users.js

Generates users for Mail OTP and Silent Auth benchmarks.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BASE_URL` | **Yes** | - | Target Authrim Worker URL |
| `ADMIN_API_SECRET` | **Yes** | - | Admin API Bearer token |
| `OTP_USER_COUNT` | No | `500` | Number of users to create |
| `CONCURRENCY` | No | `20` | Parallel requests |

### seed-passkey-users.js

Generates users with registered passkeys for Passkey benchmark.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BASE_URL` | **Yes** | - | Target Authrim Worker URL |
| `ADMIN_API_SECRET` | **Yes** | - | Admin API Bearer token |
| `PASSKEY_USER_COUNT` | No | `100` | Number of users to create |
| `CONCURRENCY` | No | `10` | Parallel requests |

### seed-authcodes.js

Generates authorization codes for token endpoint benchmarks.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BASE_URL` | **Yes** | - | Target Authrim Worker URL |
| `CLIENT_ID` | **Yes** | - | OAuth client ID |
| `CLIENT_SECRET` | **Yes** | - | OAuth client secret |
| `ADMIN_API_SECRET` | **Yes** | - | Admin API Bearer token |
| `AUTH_CODE_COUNT` | No | `200` | Number of codes to generate |

### seed-refresh-tokens.js

Generates refresh tokens for refresh token rotation benchmarks.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BASE_URL` | **Yes** | - | Target Authrim Worker URL |
| `CLIENT_ID` | **Yes** | - | OAuth client ID |
| `CLIENT_SECRET` | **Yes** | - | OAuth client secret |
| `ADMIN_API_SECRET` | **Yes** | - | Admin API Bearer token |
| `COUNT` | No | `120` | Number of tokens to generate |

### About Redirect URIs

As an OAuth 2.0 security requirement, the `redirect_uri` in the `/authorize` request must be included in the `redirect_uris` registered with the client.

- **Default**: `https://localhost:3000/callback` (for testing, no actual server needed)
- **Note**: HTTPS is required in conformance environment (`http://` will be rejected)
- If you specified a different URI during client creation, use the same value in the `REDIRECT_URI` environment variable

```bash
# Using custom redirect URI
REDIRECT_URI="https://mytest.local/callback" \
CLIENT_ID=xxx \
CLIENT_SECRET=yyy \
node generate-seeds.js
```

For details, see [Admin Client API Documentation](../docs/api/admin/clients.md).

## Reports

Load test reports are available in the `reports/Dec2025/` directory:

- [Silent Auth Benchmark](./reports/Dec2025/silent-auth.md)
- [UserInfo Benchmark](./reports/Dec2025/userinfo.md)
- [Token Exchange Benchmark](./reports/Dec2025/token-exchange.md)
- [Token Introspection Benchmark](./reports/Dec2025/token-introspection.md)
- [Full Login (Mail OTP) Benchmark](./reports/Dec2025/full-login-otp.md)

See also: [Reports Index](./reports/Dec2025/README.md) for performance summary across all benchmarks.

## Collected Metrics

After test completion, the following metrics are automatically collected from the Cloudflare GraphQL API.

### Worker Metrics

| Metric                      | Description                       | Unit  |
| --------------------------- | --------------------------------- | ----- |
| `duration` (p50/p90/p99)    | Worker execution time percentiles | ms    |
| `cpu_time` (p50/p90/p99)    | CPU execution time percentiles    | ms    |
| `memory_max` / `memory_avg` | Memory usage (max/average)        | MB    |
| `cpu_throttling_count`      | CPU throttling occurrences        | count |
| `worker_errors` (5xx)       | 5xx error count                   | count |
| `requests_by_status`        | Requests by status code           | count |

### Durable Objects Metrics

| Metric                                       | Description                               | Unit  |
| -------------------------------------------- | ----------------------------------------- | ----- |
| `do_duration` (p50/p90/p99)                  | DO Wall Time (execution time) percentiles | ms    |
| `do_waitTime` (p50/p95/p99)                  | DO wait time percentiles                  | ms    |
| `do_requests_total`                          | Total DO requests                         | count |
| `do_concurrency`                             | Concurrent executions                     | -     |
| `do_errors`                                  | DO errors (including CPU/memory exceeded) | count |
| `storage_read_units` / `storage_write_units` | Storage read/write units                  | units |

### D1 Database Metrics

| Metric                             | Description                      | Unit  |
| ---------------------------------- | -------------------------------- | ----- |
| `d1_read_count` / `d1_write_count` | Read/write query count           | count |
| `d1_duration` (p50/p95/p99)        | Query execution time percentiles | ms    |
| `d1_rate_limited_count`            | Rate limit occurrences           | count |
| `rows_read` / `rows_written`       | Rows read/written                | rows  |

### KV Metrics

| Metric             | Description         | Unit  |
| ------------------ | ------------------- | ----- |
| `kv_reads_total`   | KV read operations  | count |
| `kv_writes_total`  | KV write operations | count |
| `kv_cache_hits`    | Edge cache hits     | count |
| `kv_cache_misses`  | Edge cache misses   | count |
| `kv_read_duration` | KV read latency     | ms    |

### Overall Metrics

| Metric                   | Description                                 | Unit  |
| ------------------------ | ------------------------------------------- | ----- |
| `requests_by_pop`        | Request distribution by edge location (PoP) | count |
| `retries`                | Cloudflare-side retry count                 | count |
| `inflight_requests_peak` | Peak concurrent in-flight requests          | count |

### Metrics Collection Usage

```bash
# Manually fetch after test completion
node scripts/fetch-cf-analytics.js --start "2025-11-30T10:20:00Z" --end "2025-11-30T10:35:00Z"

# Fetch data for last N minutes
node scripts/fetch-cf-analytics.js --minutes 15

# Output in JSON format (for pipelines)
node scripts/fetch-cf-analytics.js --minutes 10 --json > metrics.json

# Test scripts (run-light-test.sh etc.) automatically collect metrics
export CF_API_TOKEN="your_cloudflare_api_token"
./run-light-test.sh
```

> **Tip**: Metrics are automatically saved to `results/cf-analytics_YYYY-MM-DDTHH-MM-SS.json`.

---

## Test Criteria (Pass/Fail Thresholds)

### 1. /token Endpoint

- p99 < 500ms
- error rate < 1%
- Stable 200-300 RPS indicates sufficient production capacity

### 2. Refresh Storm

- p99 < 700ms
- error rate < 2%
- Stable 300-800 RPS is ideal
- D1 write errors must be 0

### 3. Full OIDC

- p99 < 500ms
- error rate < 1%
- Stable 50 RPS → Sufficient headroom for 100K MAU real service

## Troubleshooting

### k6 not found

```bash
# macOS
brew install k6

# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

### wrangler authentication error

```bash
# Logout and re-login
wrangler logout
wrangler login

# Or set API token directly
export CLOUDFLARE_API_TOKEN=your_token_here
```

### Tests failing with 429 errors

- Check Cloudflare Workers plan (Unlimited recommended)
- Check Rate Limit settings
- Switch to Light preset and retry

## License

This test framework is part of the Authrim project.

## Contributing

Please report improvements or bugs via Issue or PR.
