# Optimal Shard Count Configuration Guide

## Overview

Authrim's AuthorizationCodeStore distributes authorization codes across multiple shards of Durable Objects (DO). Too many shards increase Cold Start overhead during low load, while too few shards prevent benefiting from parallel processing during high load.

This document provides recommended shard counts based on load level (RPS).

## Optimal Shard Count Approach

### Basic Principles

1. **Each shard processes sufficient requests** - Amortize Cold Start costs
2. **Maximize parallel processing** - Improve throughput during high load
3. **Resource efficiency** - Avoid unnecessary DO instance launches

### Calculation Formula

```
Optimal shard count = RPS × Test time (seconds) / Target requests per shard

Target: 50-200 requests per shard
```

## Recommended Shard Count by RPS

| RPS Range | Total Requests<br>(2-min test) | Recommended Shards | Requests/Shard | Use Case |
|---------|------------------------|--------------|---------------------|------|
| **1-5 RPS** | 120-600 | **1-2** | 60-600 | Development/Debug |
| **5-10 RPS** | 600-1,200 | **2-4** | 150-600 | Light load testing |
| **10-30 RPS** | 1,200-3,600 | **4-8** | 150-900 | Light preset |
| **30-50 RPS** | 3,600-6,000 | **8-12** | 300-750 | Low production load |
| **50-100 RPS** | 6,000-12,000 | **12-24** | 250-1,000 | Medium production load |
| **100-200 RPS** | 12,000-24,000 | **24-48** | 250-1,000 | Standard production load |
| **200-300 RPS** | 24,000-36,000 | **48-64** | 375-750 | High production load |
| **300-500 RPS** | 36,000-60,000 | **64-96** | 375-937 | Peak load |
| **500-1000 RPS** | 60,000-120,000 | **96-128** | 468-1,250 | Extreme load |
| **1000+ RPS** | 120,000+ | **128+** | 937+ | Spike protection |

## Implementation

### 1. Environment Variable Configuration

Set `AUTHRIM_CODE_SHARDS` in `wrangler.toml` or as an environment variable:

```toml
[vars]
# Development environment: Light load testing
AUTHRIM_CODE_SHARDS = "4"

# Production environment: 300 RPS target
AUTHRIM_CODE_SHARDS = "64"

# Peak protection: 1000 RPS support
AUTHRIM_CODE_SHARDS = "128"
```

### 2. Reference in Code

```typescript
import { getAuthCodeShardIndex } from '@authrim/shared';

// Get from environment variable (default: 64)
const shardCount = Number(env.AUTHRIM_CODE_SHARDS) || 64;
const shardIndex = getAuthCodeShardIndex(shardCount);
```

## Performance Impact

### Cold Start Overhead

| Shard Count | Active Shards at<br>20 RPS | Cold Start<br>Frequency | P95 Response |
|-----------|---------------------------|------------------|-------------|
| 1 | 1 (100%) | Low | ~50ms |
| 4 | 3-4 (75-100%) | Low | ~60ms |
| 8 | 5-6 (62-75%) | Medium | ~80ms |
| 16 | 8-10 (50-62%) | Medium | ~120ms |
| 32 | 12-15 (37-46%) | High | ~200ms |
| 64 | 15-20 (23-31%) | High | ~350ms |
| **128** | **18-25 (14-19%)** | **Very High** | **~600ms** ⚠️ |

### High Load Parallel Processing

| Shard Count | Parallelism at<br>300 RPS | Throughput<br>Limitation | P95 Response |
|-----------|------------------|------------------|-------------|
| 16 | 16 | Bottleneck occurs | ~800ms |
| 32 | 32 | Some limitation | ~400ms |
| **64** | **64** | **Optimal** | **~200ms** ✅ |
| 128 | 128 | Over-spec | ~180ms |

## Recommended Presets

### Development/Test Environment
```toml
AUTHRIM_CODE_SHARDS = "4"
```
- Expected load: 1-30 RPS
- Minimize Cold Start
- Easy to debug

### Staging Environment
```toml
AUTHRIM_CODE_SHARDS = "16"
```
- Expected load: 30-100 RPS
- Behavior close to production
- Good cost efficiency

### Production Environment (Standard)
```toml
AUTHRIM_CODE_SHARDS = "64"
```
- Expected load: 100-500 RPS
- Well balanced
- Can handle peaks

### Production Environment (High Load)
```toml
AUTHRIM_CODE_SHARDS = "128"
```
- Expected load: 500-1000+ RPS
- Spike protection
- Maximum parallelism

## Dynamic Sharding (Future Improvement)

Current implementation uses static sharding, but dynamic adjustment is desirable:

```typescript
/**
 * Dynamically adjust shard count based on load (proposal)
 */
function getOptimalShardCount(currentRps: number): number {
  if (currentRps < 10) return 4;
  if (currentRps < 30) return 8;
  if (currentRps < 100) return 16;
  if (currentRps < 300) return 64;
  return 128;
}
```

## Troubleshooting

### Symptom: P95 Response Time Exceeds 500ms

**Cause:** Too many shards causing frequent Cold Starts

**Solution:**
1. Check current RPS
2. Select recommended shard count from table above
3. Reduce `AUTHRIM_CODE_SHARDS`
4. Redeploy and validate

### Symptom: Timeouts During High Load

**Cause:** Too few shards resulting in insufficient parallel processing

**Solution:**
1. Check peak RPS
2. Double the shard count
3. Adjust gradually

## Summary

- **Low Load (< 30 RPS):** Shard count 4-8
- **Medium Load (30-100 RPS):** Shard count 8-24
- **High Load (100-300 RPS):** Shard count 24-64
- **Extreme Load (> 300 RPS):** Shard count 64-128

**The current setting (128 shards) is intended for 500+ RPS. For tests under 300 RPS, reducing to 64 shards is recommended.**
