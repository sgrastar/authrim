# Authrim Load Testing Specification

Load testing presets for Authrim, targeting home and semi-commercial use cases.

## Table of Contents

- [Overview](#overview)
- [Test Environment Architecture](#test-environment-architecture)
- [Test Presets](#test-presets)
- [Quick Start](#quick-start)
- [Detailed Documentation](#detailed-documentation)

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

For details, see [docs/architecture.md](./docs/architecture.md).

## Test Presets

### TEST 1: /token Endpoint Load Test

Measures peak tolerance of authentication flow.

| Preset | RPS | Duration | VUs | Expected |
|--------|-----|----------|-----|----------|
| **Light** | 5 → 20 | 60s | 20 | p99 < 250ms |
| **Standard** | 30 → 100 | 120s | 100 | p99 < 500ms |
| **Heavy** | 200 → 600 | 180s | 200-600 | Measure 429/500 error rate |

### TEST 2: Refresh Token Storm

Measures real-world maximum traffic handling.

| Preset | RPS | Duration | Expected |
|--------|-----|----------|----------|
| **Light** | 50 | 5min | p99 < 300ms |
| **Standard** | 200-500 | 10min | error rate < 0.1% |
| **Heavy** | 800-1200 | 10min | Measure DO lock contention |

### TEST 3: Full OIDC Authentication Flow

Workload closest to real service usage.

| Preset | RPS | Duration | Expected |
|--------|-----|----------|----------|
| **Light** | 10-20 | 120s | p99 < 300ms |
| **Standard** | 30-50 | 180s | p99 < 500ms |
| **Heavy** | 80-100 | 180s | Measure latency spike threshold |

For details, see [docs/test-scenarios.md](./docs/test-scenarios.md).

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
BASE_URL=https://conformance.authrim.com

# Test client credentials
CLIENT_ID=test_client_id
CLIENT_SECRET=test_client_secret

# Cloudflare settings (for metrics collection)
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_api_token
```

### 3. Run Tests

```bash
# Run TEST 1 with Light preset
./scripts/run-test.sh test1 light

# Run TEST 2 with Standard preset
./scripts/run-test.sh test2 standard

# Run TEST 3 with Heavy preset
./scripts/run-test.sh test3 heavy
```

### 4. Collect Results

```bash
# Fetch metrics from Cloudflare Analytics
./scripts/collect-metrics.sh

# Results are saved in results/ directory
ls -la results/
```

## Directory Structure

```
load-testing/
├── README.md                          # This file
├── docs/                              # Detailed documentation
│   ├── architecture.md                # Test environment architecture
│   ├── test-scenarios.md              # Test scenario details
│   └── metrics-collection.md          # Metrics collection procedures
├── scripts/                           # Test scripts
│   ├── test1-token-load.js            # TEST 1: /token endpoint
│   ├── test2-refresh-storm.js         # TEST 2: Refresh Storm
│   ├── test3-full-oidc.js             # TEST 3: Full OIDC
│   ├── run-test.sh                    # Test execution helper
│   ├── collect-metrics.sh             # Metrics collection script
│   └── generate-seeds.js              # Seed data generation script
├── seeds/                             # Seed data output directory
├── queries/                           # GraphQL queries
│   └── worker_stats.graphql           # Worker statistics query
├── presets/                           # Preset configurations
│   ├── light.json                     # Light preset
│   ├── standard.json                  # Standard preset
│   └── heavy.json                     # Heavy preset
└── results/                           # Test results (gitignored)
```

---

## Seed Data Generation (generate-seeds.js)

Script to pre-generate authorization codes and refresh tokens for load testing.

### Usage

```bash
cd load-testing/scripts

# Basic usage
CLIENT_ID=xxx CLIENT_SECRET=yyy ADMIN_API_SECRET=zzz node generate-seeds.js
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BASE_URL` | No | `https://conformance.authrim.com` | Target Authrim Worker URL |
| `CLIENT_ID` | **Yes** | - | OAuth client ID |
| `CLIENT_SECRET` | **Yes** | - | OAuth client secret |
| `REDIRECT_URI` | No | `https://localhost:3000/callback` | Redirect URI |
| `ADMIN_API_SECRET` | No | - | Admin API Bearer token |
| `AUTH_CODE_COUNT` | No | `200` | Number of authorization codes to generate |
| `REFRESH_COUNT` | No | `200` | Number of refresh tokens to generate |
| `OUTPUT_DIR` | No | `../seeds` | Output directory |

### Output Files

```
seeds/
├── auth_codes.json        # authorization code + PKCE verifier
└── refresh_tokens.json    # refresh token
```

### Prerequisites: Client Creation

You can create a test client using the Admin API.

> **Important**: The `redirect_uris` during client creation must match the `REDIRECT_URI` in generate-seeds.js.

```bash
# Create client (matching default REDIRECT_URI)
curl -X POST "https://conformance.authrim.com/api/admin/clients" \
  -H "Authorization: Bearer YOUR_ADMIN_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Load Test Client",
    "redirect_uris": ["https://localhost:3000/callback"],
    "grant_types": ["authorization_code", "refresh_token"],
    "scope": "openid profile email",
    "skip_consent": true
  }'

# Example response:
# {
#   "client": {
#     "client_id": "550e8400-e29b-...",
#     "client_secret": "a1b2c3d4e5f6...",
#     ...
#   }
# }

# Generate seeds using the obtained client_id and client_secret
CLIENT_ID="550e8400-e29b-..." \
CLIENT_SECRET="a1b2c3d4e5f6..." \
ADMIN_API_SECRET="YOUR_ADMIN_API_SECRET" \
node generate-seeds.js
```

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

## Detailed Documentation

- [Test Environment Architecture](./docs/architecture.md) - Detailed test environment configuration
- [Test Scenario Details](./docs/test-scenarios.md) - Detailed specifications for each test
- [Metrics Collection Procedures](./docs/metrics-collection.md) - How to retrieve results from Cloudflare Analytics

## Collected Metrics

After test completion, the following metrics are automatically collected from the Cloudflare GraphQL API.

### Worker Metrics

| Metric | Description | Unit |
|--------|-------------|------|
| `duration` (p50/p90/p99) | Worker execution time percentiles | ms |
| `cpu_time` (p50/p90/p99) | CPU execution time percentiles | ms |
| `memory_max` / `memory_avg` | Memory usage (max/average) | MB |
| `cpu_throttling_count` | CPU throttling occurrences | count |
| `worker_errors` (5xx) | 5xx error count | count |
| `requests_by_status` | Requests by status code | count |

### Durable Objects Metrics

| Metric | Description | Unit |
|--------|-------------|------|
| `do_duration` (p50/p90/p99) | DO Wall Time (execution time) percentiles | ms |
| `do_waitTime` (p50/p95/p99) | DO wait time percentiles | ms |
| `do_requests_total` | Total DO requests | count |
| `do_concurrency` | Concurrent executions | - |
| `do_errors` | DO errors (including CPU/memory exceeded) | count |
| `storage_read_units` / `storage_write_units` | Storage read/write units | units |

### D1 Database Metrics

| Metric | Description | Unit |
|--------|-------------|------|
| `d1_read_count` / `d1_write_count` | Read/write query count | count |
| `d1_duration` (p50/p95/p99) | Query execution time percentiles | ms |
| `d1_rate_limited_count` | Rate limit occurrences | count |
| `rows_read` / `rows_written` | Rows read/written | rows |

### KV Metrics

| Metric | Description | Unit |
|--------|-------------|------|
| `kv_reads_total` | KV read operations | count |
| `kv_writes_total` | KV write operations | count |
| `kv_cache_hits` | Edge cache hits | count |
| `kv_cache_misses` | Edge cache misses | count |
| `kv_read_duration` | KV read latency | ms |

### Overall Metrics

| Metric | Description | Unit |
|--------|-------------|------|
| `requests_by_pop` | Request distribution by edge location (PoP) | count |
| `retries` | Cloudflare-side retry count | count |
| `inflight_requests_peak` | Peak concurrent in-flight requests | count |

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
