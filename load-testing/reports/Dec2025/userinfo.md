# UserInfo Endpoint Load Test Report

**Test Date**: December 12, 2025
**Target**: Authrim OIDC Provider - UserInfo Endpoint (`/userinfo`)
**Test Tool**: K6 Cloud (Distributed Load Testing)
**Monitoring**: Cloudflare Analytics API

---

## 1. Test Purpose

Measure the maximum throughput and performance limits of the UserInfo endpoint with Bearer Token authentication, evaluating JWT validation performance under high load.

**Target Endpoint**:
```
GET /userinfo
Authorization: Bearer {access_token}
```

**Test Characteristics**:
- Authentication: Bearer Token (JWT)
- Success Criteria: HTTP 200 + `sub` claim present
- Token Pool: 4,000 pre-generated valid tokens
- JWT Validation: RS256 signature verification (with JWK caching)

---

## 2. Test Configuration

| Component | Details |
|-----------|---------|
| Load Generator | K6 Cloud (amazon:us:portland) |
| Infrastructure | Cloudflare Workers + Durable Objects + D1 |
| Token Count | 4,000 tokens (fetched from R2) |
| Test Duration | Warmup 30s + Benchmark 3min 30s |

### K6 Configuration Example (2000 RPS)

```javascript
{
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      rate: 50,
      duration: '30s',
      exec: 'warmupScenario',
    },
    userinfo_benchmark: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 2400,
      maxVUs: 3000,
      stages: [
        { target: 1000, duration: '15s' },
        { target: 2000, duration: '180s' },
        { target: 0, duration: '15s' },
      ],
      startTime: '30s',
    },
  },
}
```

---

## 3. Test Execution

### 3.1 Test Matrix

| RPS | Execution Time (JST) | Analytics Period (UTC) |
|----:|----------------------|------------------------|
| 1,000 | 01:08 | 16:01:00 - 16:07:00 |
| 2,000 | 01:20 | 16:13:00 - 16:21:00 |
| 2,500 | 01:40 | 16:36:00 - 16:42:00 |
| 3,000 | 01:30 | 16:27:00 - 16:33:00 |

---

## 4. Results

### 4.1 Performance Summary

| RPS | K6 Total Requests | CF Total Requests | K6 Failures | CF Worker Errors | CF DO Errors | Status |
|----:|------------------:|------------------:|------------:|-----------------:|-------------:|:------:|
| 1,000 | 146,231 | 146,231 | 0 | 0 | 0 | PASS |
| 2,000 | 293,947 | 293,947 | 0 | 0 | 0 | PASS |
| 2,500 | 365,648 | 365,648 | 0 | 0 | 0 | WARN |
| 3,000 | 436,456 | 436,456 | 0 | 0 | 0 | WARN |

> **Note**: WARN indicates K6 threshold exceeded. All RPS levels achieved 0% HTTP error rate.

### 4.2 Performance Capacity

| Configuration | Recommended Operation | Peak Handling | Hard Limit |
|---------------|----------------------|---------------|------------|
| **Standard** | 2,000 RPS | 2,500 RPS | 3,000 RPS |

---

## 5. Data

### 5.1 K6 Client HTTP Response Time (ms)

| RPS | Total | P50 | Mean | P95 | P99 | Max |
|----:|------:|----:|-----:|----:|----:|----:|
| 1,000 | 144,720 | 114 | 117 | 139 | 200 | 4,523 |
| 2,000 | 292,447 | 118 | 133 | 254 | 350 | 29,717 |
| 2,500 | 364,147 | 127 | 174 | 325 | 585 | 5,842 |
| 3,000 | 434,955 | 150 | 298 | 1,032 | 1,736 | 5,462 |

### 5.2 Cloudflare Worker Duration (ms)

| RPS | Total | P50 | P75 | P90 | P99 | P999 |
|----:|------:|----:|----:|----:|----:|-----:|
| 1,000 | 146,231 | 13.22 | 14.14 | 15.62 | 31.20 | 88.22 |
| 2,000 | 293,947 | 14.11 | 16.57 | 24.15 | 44.54 | 176.35 |
| 2,500 | 365,648 | 15.99 | 27.52 | 55.91 | 178.63 | 668.57 |
| 3,000 | 436,456 | 17.58 | 50.69 | 124.55 | 231.23 | 596.17 |

### 5.3 Cloudflare Worker CPU Time (ms)

| RPS | P50 | P75 | P90 | P99 | P999 |
|----:|----:|----:|----:|----:|-----:|
| 1,000 | 1.10 | 1.23 | 1.50 | 4.02 | 5.28 |
| 2,000 | 1.07 | 1.18 | 1.42 | 3.96 | 4.81 |
| 2,500 | 1.06 | 1.17 | 1.43 | 3.97 | 4.85 |
| 3,000 | 1.05 | 1.17 | 1.44 | 3.98 | 4.92 |

### 5.4 Cloudflare Durable Objects Wall Time (ms)

| RPS | Total DO Requests | DO Errors | P50 | P75 | P90 | P99 | P999 |
|----:|------------------:|----------:|----:|----:|----:|----:|-----:|
| 1,000 | 146,324 | 0 | 0.82 | 1.87 | 3.38 | 7.83 | 89.34 |
| 2,000 | 294,023 | 0 | 0.46 | 0.74 | 1.63 | 6.87 | 40.59 |
| 2,500 | 352,388 | 0 | 0.40 | 0.58 | 1.19 | 5.41 | 39.51 |
| 3,000 | 366,986 | 0 | 0.38 | 0.54 | 0.94 | 6.07 | 58.62 |

> **Note**: Higher RPS improves DO Wall Time due to improved cache hit rate.

### 5.5 D1 Database Metrics

| RPS | Read Queries | Write Queries | Rows Read | Rows Written |
|----:|-------------:|--------------:|----------:|-------------:|
| 1,000 | 525,433 | 341,182 | 470,091 | 1,982,394 |
| 2,000 | 525,821 | 341,182 | 470,479 | 1,982,394 |
| 2,500 | 529,698 | 341,182 | 474,356 | 1,982,394 |
| 3,000 | 528,988 | 341,182 | 473,646 | 1,982,394 |

---

## 6. Conclusion

### 6.1 Performance Evaluation

| Metric | Result |
|--------|--------|
| **Max Throughput** | 3,000 RPS (0% error rate) |
| **Recommended Operation** | 2,000 RPS (K6 P99 < 350ms) |
| **Peak Handling** | 2,500 RPS (K6 P99 < 600ms) |

### 6.2 Key Findings

1. **JWT validation is fast**: CPU time stable at 1-4ms across all RPS levels (V8 WebCrypto + JWK cache effect)
2. **DO (KeyManager) is ultra-fast**: Wall Time P99 stable at 5-8ms
3. **Bottleneck is Worker Duration**: Request queueing at high RPS is the primary factor
4. **Cache is effective**: USER_CACHE KV keeps D1 writes constant
5. **0% failure rate across all RPS**: Reliability maintained even at throughput limits

### 6.3 Comparison with Silent Auth

| Endpoint | Recommended | Peak | Hard Limit |
|----------|------------|------|------------|
| **Silent Auth** | 2,000 RPS | 3,000 RPS | 4,000 RPS |
| **UserInfo** | 2,000 RPS | 2,500 RPS | 3,000 RPS |

> UserInfo has lower throughput than Silent Auth due to JWT validation + D1 read overhead.

**Authrim's UserInfo endpoint achieves 2,000-3,000 RPS with zero errors, with JWT signature verification on every request.**

---

*Test conducted: December 12, 2025*
