# Authrim Load Test Results Report

## Overview

This document summarizes the load test results for Authrim's OAuth2/OIDC server `/token` endpoint.

**Test Environment:**
- Target: `https://conformance.authrim.com`
- Test Date: 2025-12-01
- Testing Tool: k6
- Infrastructure: Cloudflare Workers + Durable Objects + D1

### Test Environment Configuration (Differences from Production)

| Configuration Item | Test1 (authorization_code) | Test2 (refresh_token) | Production Recommended | Reason |
|---------|---------------------------|----------------------|-----------|------|
| `CODE_EXPIRY` | 3600s (1 hour) | 3600s (1 hour) | 120s (2 min) | Extended for pre-seed generation. Token issuance processing itself is identical |
| `REFRESH_TOKEN_ROTATION_ENABLED` | false | **true** | true | Test1 uses auth_code only. Test2 validates production-like rotation behavior |
| `AUTHRIM_CODE_SHARDS` | 128 | 128 | 64-128 | Increased for enhanced load distribution |

**Production Consistency:**
- The `/token` endpoint authorization_code grant processing is **completely identical** to production
- Only CODE_EXPIRY is longer; JWT signing, DO processing, and D1 queries are under the same load as production
- Refresh token rotation doesn't affect this test flow

---

## Optimization History

| Date | Optimization | Impact |
|------|-----------|------|
| 2025-11-30 | AuthCodeStore sharding (**64 shards**) | Reduced DO contention, load distribution |
| 2025-11-30 | KeyManager Worker-side cache (TTL 5 min) | Reduced DO hops |
| 2025-12-01 | RefreshTokenRotator fine-grained storage | Reduced storage I/O |
| 2025-12-01 | RefreshTokenRotator differential save | Reduced writes |
| 2025-12-01 | RefreshTokenRotator conditional async audit logging | Reduced latency |

**Sharding Details:**
- Authorization Code Durable Objects distributed across 64 shards (`AUTHRIM_CODE_SHARDS` environment variable, default 64)
- Code format: `{shardIndex}_{randomCode}` (e.g., `76_6jKth...`)
- Random shard selection evenly distributes load across all shards
- Implementation: `packages/shared/src/utils/tenant-context.ts:101`

---

## Test Results Summary

### 1. 50RPS Test (Post-Optimization)

**Execution Date/Time:** 2025-12-01 00:59:26 JST (2025-11-30T23:59:26Z)

**Test Conditions:**
- Preset: `rps50`
- Duration: 1 min 35 sec (including ramp-up)
- Max VU: 60

**k6 Results:**
| Metric | Value |
|-----------|-----|
| Total Requests | 3,849 |
| Success Rate | 100% |
| Failures | 0 |
| p50 Response | 0ms (k6 display) |
| p90 Response | 115.76ms |
| p95 Response | 119.30ms |

**Cloudflare Analytics:**
- File: `results/cf-analytics_2025-12-01T00-02-31.json`
- Period: 2025-11-30T23:59:00Z ~ 2025-12-01T00:03:00Z

| Metric | Value |
|-----------|-----|
| Worker Duration p50 | 11.60 ms |
| Worker Duration p75 | 12.49 ms |
| Worker Duration p90 | 12.91 ms |
| Worker Duration p99 | 16.00 ms |
| Worker Duration p999 | 133.13 ms |
| CPU Time p50 | 4.69 ms |
| CPU Time p99 | 8.10 ms |
| DO Wall Time p50 | 19.50 ms |
| DO Wall Time p99 | 11,194.05 ms |
| DO Wall Time p999 | 43,649.00 ms |
| D1 Read Queries | 76,715 |
| D1 Write Queries | 56,310 |

---

### 2. 50RPS Test (Pre-Optimization - Baseline)

**Execution Date/Time:** 2025-11-30 19:11:07 JST (2025-11-30T18:51:00Z)

**Cloudflare Analytics:**
- File: `results/cf-analytics_2025-11-30T19-11-07.json`
- Period: 2025-11-30T18:51:00Z ~ 2025-11-30T18:53:00Z

| Metric | Value |
|-----------|-----|
| Worker Duration p50 | 30.53 ms |
| Worker Duration p75 | 93.19 ms |
| Worker Duration p90 | 164.16 ms |
| Worker Duration p99 | 261.65 ms |
| Worker Duration p999 | 414.82 ms |
| CPU Time p50 | 4.68 ms |
| CPU Time p99 | 7.55 ms |
| DO Wall Time p50 | 59.22 ms |
| DO Wall Time p99 | 13,919.74 ms |
| DO Wall Time p999 | 131,496.91 ms |
| D1 Read Queries | 58,752 |
| D1 Write Queries | 48,582 |

---

## Optimization Effect Comparison

### Worker Duration

| Percentile | Pre-Optimization | Post-Optimization | Improvement |
|---------------|---------|---------|--------|
| p50 | 30.53 ms | 11.60 ms | **-62%** |
| p75 | 93.19 ms | 12.49 ms | **-87%** |
| p90 | 164.16 ms | 12.91 ms | **-92%** |
| p99 | 261.65 ms | 16.00 ms | **-94%** |
| p999 | 414.82 ms | 133.13 ms | **-68%** |

### Durable Objects Wall Time

| Percentile | Pre-Optimization | Post-Optimization | Improvement |
|---------------|---------|---------|--------|
| p50 | 59.22 ms | 19.50 ms | **-67%** |
| p75 | 489.57 ms | 73.55 ms | **-85%** |
| p90 | 2,600.01 ms | 2,415.96 ms | -7% |
| p99 | 13,919.74 ms | 11,194.05 ms | **-20%** |
| p999 | 131,496.91 ms | 43,649.00 ms | **-67%** |

---

## 100RPS Test

**Execution Date/Time:** 2025-12-01 09:48:11 JST (2025-12-01T00:48:11Z)

**Test Conditions:**
- Preset: `rps100`
- Duration: approx 2 min 45 sec (maintaining 100RPS for 2 min)
- Max VU: 150
- Seed count: 15,000

**k6 Results:**
- **Log file:** `results/test1-rps100_20251201_014811.log`

| Metric | Value |
|-----------|-----|
| Total Requests | **14,775** |
| Success Rate | **100%** |
| Failures | 0 |
| p50 Response | 0ms (k6 display) |
| p90 Response | 114.94ms |
| p95 Response | **119.17ms** |
| p99 Response | 127.58ms |

**Cloudflare Analytics:**
- File: `results/cf-analytics_2025-12-01T02-52-03.json`
- Period: 2025-12-01T00:48:00Z ~ 2025-12-01T00:52:00Z

| Metric | Value |
|-----------|-----|
| Worker Duration p50 | 17.20 ms |
| Worker Duration p75 | 18.21 ms |
| Worker Duration p90 | 19.26 ms |
| Worker Duration p99 | 22.57 ms |
| Worker Duration p999 | 157.26 ms |
| CPU Time p50 | 2.18 ms |
| CPU Time p99 | 6.00 ms |
| DO Wall Time p50 | 10.08 ms |
| DO Wall Time p99 | 2,789.84 ms |
| DO Wall Time p999 | 107,490.74 ms |
| D1 Read Queries | 150,114 |
| D1 Write Queries | 209,835 |

---

## 200RPS Test

**Execution Date/Time:** 2025-12-01 11:07:43 JST (2025-12-01T02:07:43Z)

**Test Conditions:**
- Preset: `rps200`
- Duration: approx 2 min 45 sec (maintaining 200RPS for 2 min)
- Max VU: 200
- Seed count: 30,000

**k6 Results:**
- **Log file:** `results/test1-rps200_20251201_020743.log`

| Metric | Value |
|-----------|-----|
| Total Requests | **29,748** |
| Success Rate | **100%** |
| Failures | 0 |
| p50 Response | 0ms (k6 display) |
| p90 Response | 117.40ms |
| p95 Response | **123.66ms** |
| p99 Response | 131.59ms |

**Cloudflare Analytics:**
- File: `results/cf-analytics_2025-12-01T02-53-41.json`
- Period: 2025-12-01T02:12:00Z ~ 2025-12-01T02:16:00Z

| Metric | Value |
|-----------|-----|
| Worker Duration p50 | 11.58 ms |
| Worker Duration p75 | 12.14 ms |
| Worker Duration p90 | 12.80 ms |
| Worker Duration p99 | 25.50 ms |
| Worker Duration p999 | 426.66 ms |
| CPU Time p50 | 4.65 ms |
| CPU Time p99 | 9.82 ms |
| DO Wall Time p50 | 9.42 ms |
| DO Wall Time p99 | 2,658.30 ms |
| DO Wall Time p999 | 41,864.63 ms |
| D1 Read Queries | 150,114 |
| D1 Write Queries | 209,835 |

**Scaling Characteristics:**
- 100→200RPS: Request count doubled
- p95 Response: 119.17ms → 123.66ms (+3.8%) - Nearly linear scaling

---

## 300RPS Test

**Execution Date/Time:** 2025-12-01 11:21:38 JST (2025-12-01T02:21:38Z)

**Test Conditions:**
- Preset: `rps300`
- Duration: approx 2 min 50 sec (maintaining 300RPS for 2 min)
- Max VU: 300
- Seed count: 50,000

**k6 Results:**
- **Log file:** `results/test1-rps300_20251201_022138.log`
- **Seed generation log:** `/tmp/seed_gen_300rps.log`

| Metric | Value |
|-----------|-----|
| Total Requests | **48,708** |
| Success Rate | **99.998%** |
| Failures | 1 (network timeout) |
| p50 Response | 0ms (k6 display) |
| p90 Response | 124.35ms |
| p95 Response | **138.75ms** |
| p99 Response | 1,027.85ms |

**Cloudflare Analytics:**
- File: `results/cf-analytics_2025-12-01T02-54-07.json`
- Period: 2025-12-01T02:21:00Z ~ 2025-12-01T02:25:00Z

| Metric | Value |
|-----------|-----|
| Worker Duration p50 | 17.58 ms |
| Worker Duration p75 | 18.66 ms |
| Worker Duration p90 | 19.85 ms |
| Worker Duration p99 | 34.00 ms |
| Worker Duration p999 | 416.31 ms |
| CPU Time p50 | 4.59 ms |
| CPU Time p99 | 10.80 ms |
| DO Wall Time p50 | 10.10 ms |
| DO Wall Time p99 | 1,875.07 ms |
| DO Wall Time p999 | 34,270.47 ms |
| D1 Read Queries | 150,114 |
| D1 Write Queries | 209,835 |

**Scaling Characteristics:**
- 200→300RPS: Request count 1.5x increase
- p95 Response: 123.66ms → 138.75ms (+12.2%) - Slight non-linearity
- Tail latency at p99 (1,027ms) - Indicates load concentration at 300RPS

**Seed Generation:**
- 50,000 code generation: 310.3 seconds
- Generation speed: 161.1 codes/sec
- Concurrency: 30 concurrent requests

---

## Test Results Comparison Table

| RPS | Total Requests | Success Rate | p95 Response | p99 Response | Result File |
|-----|------------|--------|-------------|-------------|------------|
| 50 | 3,849 | 100% | 119.30ms | - | - |
| **100** | **14,775** | **100%** | **119.17ms** | 127.58ms | `test1-rps100_20251201_014811.log` |
| **200** | **29,748** | **100%** | **123.66ms** | 131.59ms | `test1-rps200_20251201_020743.log` |
| **300** | **48,708** | **99.998%** | **138.75ms** | 1,027.85ms | `test1-rps300_20251201_022138.log` |

**Performance Analysis:**
- 100-200RPS: Nearly linear scaling (p95: +3.8%)
- 200-300RPS: Slight non-linearity (p95: +12.2%)
- Large tail latency at p99 is prominent at 300RPS (exceeds 1 second)

---

## Scale Guidelines

| RPS | Token Issuance/Hour | Token Issuance/Day | Estimated MAU |
|-----|----------------|----------------|---------|
| 50 | 180,000 | 4.3M | 100K-200K |
| 100 | 360,000 | 8.6M | 200K-400K |
| 200 | 720,000 | 17.3M | 500K-1M |
| 300 | 1,080,000 | 25.9M | 1M-2M |

**Scaling Limit Estimation:**
- **Conservative Estimate:** 500 RPS (maintaining latency < 200ms)
- **Optimistic Estimate:** 800-1,000 RPS (utilizing 64 shards with current architecture)
- **Further Improvements:**
  - Increase `AUTHRIM_CODE_SHARDS` to 128 (enhanced DO distribution)
  - Further optimize Refresh Token Rotator
  - Optimize D1 queries (add indexes)

---

## Related Files

### Analytics Data
- `results/cf-analytics_2025-11-30T19-11-07.json` - Baseline (50RPS)
- `results/cf-analytics_2025-12-01T00-02-31.json` - Post-optimization (50RPS)
- `results/cf-analytics_2025-12-01T02-52-03.json` - 100RPS test
- `results/cf-analytics_2025-12-01T02-53-41.json` - 200RPS test
- `results/cf-analytics_2025-12-01T02-54-07.json` - 300RPS test

### Test Scripts
- `scripts/test1-token-load.js` - Token endpoint load test
- `scripts/generate-seeds-parallel.js` - Parallel seed generation

### Configuration Files
- `packages/op-token/wrangler.conformance.toml` - CODE_EXPIRY=3600 (for testing)
- `packages/op-auth/wrangler.conformance.toml` - CODE_EXPIRY=3600 (for testing)
