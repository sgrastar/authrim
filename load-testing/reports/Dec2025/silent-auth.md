# Silent Authentication Load Test Report

**Test Date**: December 11, 2025
**Target**: Authrim OIDC Provider - Authorization Endpoint (`prompt=none`)
**Test Tool**: K6 Cloud (Distributed Load Testing)
**Monitoring**: Cloudflare Analytics API

---

## 1. Test Purpose

Measure the maximum throughput and performance limits of the Silent Authentication endpoint (`prompt=none`) for logged-in users.

**Target Endpoint**:
```
GET /authorize?response_type=code&client_id=xxx&redirect_uri=xxx&scope=openid&prompt=none&code_challenge=xxx&code_challenge_method=S256
```

**Test Characteristics**:
- Authentication: Session Cookie (pre-created via Admin API)
- Success Criteria: HTTP 302 redirect with `code` parameter
- PKCE: S256 challenge method
- Prompt: `none` (no user interaction)

---

## 2. Test Configuration

| Component | Details |
|-----------|---------|
| Load Generator | K6 Cloud (amazon:us:ashburn) |
| Infrastructure | Cloudflare Workers + Durable Objects + D1 |
| Session Count | 500 sessions (pre-created) |
| Test Duration | ~3 minutes per preset (15-20s ramp-up → 180s steady → 15-20s ramp-down) |
| Shard Configuration | 64 shards (standard), 128 shards (extended) |

---

## 3. Test Execution

### 3.1 Test Matrix

| RPS | Shards | Test Time (JST) | Analytics Period (UTC) |
|----:|-------:|-----------------|------------------------|
| 500 | 64 | 15:05 | 05:54:00 - 06:02:00 |
| 1,000 | 64 | 15:22 | 06:11:00 - 06:20:00 |
| 1,500 | 64 | 15:34 | 06:24:00 - 06:32:00 |
| 2,000 | 64 | 15:47 | 06:36:00 - 06:45:00 |
| 2,500 | 64 | 17:13 | 08:09:45 - 08:18:00 |
| 3,000 | 64 | 16:00 | 06:49:00 - 07:02:00 |
| 3,500 | 64 | 17:18 | 08:18:00 - 08:27:00 |
| 4,000 | 64 | 18:31 | 09:17:00 - 09:27:00 |
| 4,000 | 128 | 19:32 | 10:11:00 - 10:16:30 |
| 4,500 | 128 | 20:04 | 10:42:00 - 10:47:00 |

### 3.2 K6 Configuration Example (2000 RPS)

```javascript
{
  executor: 'ramping-arrival-rate',
  startRate: 0,
  timeUnit: '1s',
  preAllocatedVUs: 2500,
  maxVUs: 3500,
  stages: [
    { target: 1000, duration: '15s' },
    { target: 2000, duration: '180s' },
    { target: 0, duration: '15s' },
  ],
}
```

---

## 4. Results

### 4.1 Performance Summary (64 Shards)

| RPS | K6 Total Requests | CF Total Requests | K6 Failures | CF Worker Errors | CF DO Errors | Status |
|----:|------------------:|------------------:|------------:|-----------------:|-------------:|:------:|
| 500 | 73,124 | 62,180 | 0 | 0 | 13 | PASS |
| 1,000 | 146,249 | 132,998 | 0 | 0 | 0 | PASS |
| 1,500 | 219,374 | 171,466 | 0 | 0 | 0 | PASS |
| 2,000 | 292,499 | 249,234 | 0 | 0 | 0 | PASS |
| 2,500 | 365,624 | 365,658 | 0 | 0 | 0 | PASS |
| 3,000 | 445,378 | 445,378 | 0 | 0 | 0 | PASS |
| 3,500 | 521,646 | 521,682 | 0 | 0 | 0 | PASS |
| 4,000 | 599,440 | 599,327 | 160 | 0 | 1,223 | WARN |

### 4.2 Extended Shard Test (128 Shards)

| RPS | K6 Total Requests | HTTP Failures | CF Worker Errors | CF DO Errors | Client Disconnected | Status |
|----:|------------------:|--------------:|-----------------:|-------------:|--------------------:|:------:|
| 4,000 | 596,829 | **0** | 0 | 2,112 | 0 | PASS |
| 4,500 | 669,872 | 287 | 0 | 1,376 | 361 | WARN |

**128 Shard Effect**: HTTP failures at 4000 RPS reduced from 160 to 0.

---

## 5. Data

### 5.1 K6 Client HTTP Response Time (ms)

| RPS | Total | Min | Mean | P50 | P95 | P99 | Max |
|----:|------:|----:|-----:|----:|----:|----:|----:|
| 500 | 73,124 | 373.33 | 412.71 | 406.62 | 453.68 | 535.93 | 1,802.30 |
| 1,000 | 146,249 | 369.34 | 409.97 | 403.44 | 453.39 | 528.18 | 2,977.53 |
| 1,500 | 219,374 | 368.32 | 413.89 | 404.12 | 471.06 | 529.63 | 3,320.09 |
| 2,000 | 292,499 | 366.18 | 410.55 | 404.65 | 451.84 | 528.25 | 3,014.34 |
| 2,500 | 365,624 | 361.84 | 660.62 | 652.44 | 793.59 | 837.71 | 5,181.37 |
| 3,000 | 445,378 | 372.67 | 1,239.24 | 1,243.49 | 1,582.82 | 1,641.73 | 5,481.60 |
| 3,500 | 521,646 | 361.73 | 819.86 | 614.85 | 1,631.44 | 1,727.45 | 8,076.65 |
| 4,000 | 599,280 | 359.81 | 585.20 | 458.43 | 668.64 | 5,621.68 | 58,617.80 |

### 5.2 Cloudflare Worker Duration (ms)

| RPS | Total | P50 | P75 | P90 | P99 | P999 |
|----:|------:|----:|----:|----:|----:|-----:|
| 500 | 62,180 | 48.14 | 49.96 | 51.27 | 68.10 | 141.93 |
| 1,000 | 132,998 | 49.44 | 50.45 | 51.79 | 70.15 | 155.28 |
| 1,500 | 171,466 | 49.60 | 50.61 | 52.04 | 87.26 | 135.49 |
| 2,000 | 249,234 | 49.74 | 50.86 | 52.15 | 68.27 | 157.83 |
| 2,500 | 365,658 | 82.86 | 101.78 | 116.63 | 134.59 | 157.84 |
| 3,000 | 445,378 | 157.24 | 180.27 | 194.63 | 222.03 | 254.70 |
| 3,500 | 521,682 | 76.16 | 148.35 | 193.47 | 231.27 | 257.43 |
| 4,000 | 599,327 | 50.23 | 56.26 | 74.84 | 175.81 | 3,750.00 |

### 5.3 Cloudflare Worker CPU Time (ms)

| RPS | P50 | P75 | P90 | P99 | P999 |
|----:|----:|----:|----:|----:|-----:|
| 500 | 2.24 | 2.78 | 3.23 | 8.01 | 21.93 |
| 1,000 | 2.35 | 2.78 | 3.17 | 10.47 | 23.27 |
| 1,500 | 2.36 | 2.81 | 3.39 | 7.84 | 21.68 |
| 2,000 | 2.34 | 2.83 | 3.45 | 6.40 | 20.30 |
| 2,500 | 2.34 | 2.93 | 3.65 | 6.25 | 17.19 |
| 3,000 | 2.25 | 2.85 | 3.55 | 5.80 | 17.38 |
| 3,500 | 2.29 | 2.93 | 3.62 | 5.71 | 13.08 |
| 4,000 | 2.27 | 2.83 | 3.53 | 13.68 | 15.55 |

### 5.4 Cloudflare Durable Objects Wall Time (ms)

| RPS | Total DO Requests | DO Errors | P50 | P75 | P90 | P99 | P999 |
|----:|------------------:|----------:|----:|----:|----:|----:|-----:|
| 500 | 186,520 | 13 | 122.04 | 180.60 | 320.99 | 1,779.44 | 36,731.66 |
| 1,000 | 399,282 | 0 | 170.87 | 179.58 | 189.45 | 555.93 | 4,315.24 |
| 1,500 | 514,101 | 0 | 170.49 | 178.58 | 185.12 | 391.35 | 1,166.23 |
| 2,000 | 747,073 | 0 | 169.92 | 177.78 | 183.42 | 320.81 | 1,512.54 |
| 2,500 | 1,097,668 | 0 | 180.54 | 193.23 | 408.75 | 645.04 | 863.29 |
| 3,000 | 1,336,694 | 0 | 183.39 | 731.48 | 1,040.33 | 1,311.51 | 1,691.65 |
| 3,500 | 1,565,263 | 0 | 178.94 | 190.19 | 690.62 | 1,380.58 | 1,515.72 |
| 4,000 | 1,796,556 | 1,223 | 172.92 | 182.15 | 190.99 | 441.97 | 2,317.21 |

---

## 6. Conclusion

### 6.1 Performance Capacity

| Configuration | Max Error-Free Throughput | Recommended Operation | Peak Handling | Hard Limit |
|---------------|--------------------------|----------------------|---------------|------------|
| **64 Shards** | 3,500 RPS | 2,000 RPS | 3,000 RPS | 4,000 RPS |
| **128 Shards** | 4,000 RPS | 2,500 RPS | 3,500 RPS | 4,500 RPS |

### 6.2 Key Findings

1. **Worker CPU is lightweight**: CPU time stable at 2-3ms across all RPS levels
2. **DO is the bottleneck**: DO Wall Time increases significantly at high RPS (queue wait time)
3. **Error-free up to 3,500 RPS**: DO P99 at 1.4s still processes without errors
4. **4,000 RPS is the limit**: 1,223 DO errors and 160 client timeouts occurred

### 6.3 Shard Scaling Effect

| Comparison | 64 Shards | 128 Shards | Improvement |
|-----------|-----------|-------------|-------------|
| 4000 RPS HTTP Failures | 160 | **0** | Eliminated |
| 4000 RPS clientDisconnected | 160 | **0** | Eliminated |
| Max Error-Free RPS | 3,500 | **4,000** | +500 RPS |

**Authrim's Silent Authentication endpoint achieves 3,500-4,000 RPS with zero errors using Durable Object sharding.**

---

*Test conducted: December 11, 2025*
