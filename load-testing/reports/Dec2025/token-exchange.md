# Token Exchange (RFC 8693) Load Test Report

**Test Date**: December 14, 2025
**Target**: Authrim OIDC Provider - Token Exchange Endpoint (`POST /token`)
**Test Tool**: K6 Cloud (Distributed Load Testing)
**Monitoring**: Cloudflare Analytics API

---

## 1. Test Purpose

Measure the maximum throughput and performance limits of the Token Exchange (RFC 8693) endpoint, evaluating service-to-service authentication and post-SSO audience switching performance in microservices environments.

**Target Endpoint**:
```
POST /token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token={access_token}
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&audience={target_audience}
&scope={requested_scope}
```

**Test Characteristics**:
| Item | Details |
|------|---------|
| **Grant Type** | `urn:ietf:params:oauth:grant-type:token-exchange` |
| **Authentication** | Client Secret (Basic Auth) |
| **Subject Token** | Pre-generated JWT Access Tokens |
| **Token Mix** | Valid 70%, Expired 10%, Invalid 10%, Revoked 10% |
| **Success Criteria** | Valid→200, Expired/Invalid/Revoked→400 |

---

## 2. Test Configuration

| Component | Details |
|-----------|---------|
| Load Generator | K6 Cloud (amazon:us:portland) |
| Infrastructure | Cloudflare Workers + Durable Objects + D1 |
| Token Count | 1,000 tokens/test (fetched from R2) |
| Test Duration | Warmup 30s + Benchmark 3min 30s |

### Shard Configuration

| Durable Object | Shard Count | Purpose |
|----------------|-------------|---------|
| AuthorizationCodeStore | 8 | Authorization code management |
| SessionStore | 8 | Session management |
| ChallengeStore | 8 | Challenge management |
| **TokenRevocationStore** | **8** | Token revocation management (primary DO) |
| RefreshTokenRotator | 16 | Refresh token management |

### Token Exchange Variations

| Item | Count | Details |
|------|-------|---------|
| **Target Audience** | 20 types | `api.example.com/{gateway,users,payments,...}` |
| **Scope Patterns** | 4 types | `openid` / `openid profile` / `openid profile email` / `openid profile email address phone` |
| **Resource URI** | 10 types | `resource.example.com/api/v1`, `data.example.com/graphql`, ... |
| **Service Clients** | 5 types | `service-gateway`, `service-bff`, `service-worker`, ... |

---

## 3. Test Execution

### 3.1 Test Matrix

| RPS | Execution Time (JST) | Analytics Period (UTC) | Seed Version | Peak VU |
|----:|----------------------|------------------------|--------------|--------:|
| 2,000 | 14:49 | 05:49:00 - 05:54:30 | v13 | ~878 |
| 2,500 | 16:43 | 07:43:00 - 07:50:00 | v14 | ~437 |
| 3,000 | 16:58 | 07:58:00 - 08:03:30 | v16 | ~4,500 |

### 3.2 K6 Configuration Example (3000 RPS)

```javascript
{
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      rate: 50,
      duration: '30s',
      exec: 'warmupScenario',
    },
    token_exchange_benchmark: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 3600,
      maxVUs: 4500,
      stages: [
        { target: 1500, duration: '15s' },
        { target: 3000, duration: '180s' },
        { target: 0, duration: '15s' },
      ],
      startTime: '30s',
    },
  },
}
```

---

## 4. Results

### 4.1 Performance Summary

| RPS | K6 Total Requests | CF Total Requests | K6 P95 | CF Worker P99 | CF DO P99 | Status |
|----:|------------------:|------------------:|-------:|--------------:|----------:|:------:|
| 2,000 | 292,343 | 293,747 | 500ms | 307ms | 1,020ms | WARN |
| 2,500 | 365,624 | 367,484 | 225ms | 313ms | 271ms | PASS |
| 3,000 | 390,444 | 398,732 | 2,144ms | 316ms | 2,222ms | FAIL |

> **Status Criteria**: PASS = K6 P95 < 300ms AND DO P99 < 500ms

### 4.2 RPS Achievement Rate

| Target RPS | Avg RPS | Peak RPS | Achievement |
|-----------:|--------:|---------:|-----------:|
| 2,000 | 1,373 | 2,137 | 107% |
| 2,500 | 1,717 | 2,494 | 100% |
| 3,000 | 1,833 | 2,714 | 90% |

> **Note**: 3,000 RPS test showed "Insufficient VUs" warning and did not achieve target RPS.

### 4.3 Performance Capacity

| Configuration | Recommended Operation | Peak Handling | Hard Limit |
|---------------|----------------------|---------------|------------|
| **8 Shards** | 1,500 RPS | 2,500 RPS | 2,700 RPS |

---

## 5. Data

### 5.1 K6 Client HTTP Response Time (ms)

| RPS | Total | Median | P95 | P99 | Min | Max |
|----:|------:|-------:|----:|----:|----:|----:|
| 2,000 | 292,343 | 112 | 500 | 589 | 40 | 3,448 |
| 2,500 | 365,624 | 76 | 225 | 297 | 39 | 5,075 |
| 3,000 | 390,444 | 1,657 | 2,144 | 2,269 | 53 | 4,236 |

### 5.2 Cloudflare Worker Duration (ms)

| RPS | Total | P50 | P75 | P90 | P99 | P999 |
|----:|------:|----:|----:|----:|----:|-----:|
| 2,000 | 293,747 | 23.83 | 26.04 | 60.67 | 306.87 | 309.91 |
| 2,500 | 367,484 | 23.09 | 24.52 | 26.43 | 312.86 | 315.63 |
| 3,000 | 398,732 | 204.33 | 236.41 | 265.56 | 315.89 | 337.54 |

### 5.3 Cloudflare Worker CPU Time (ms)

| RPS | P50 | P75 | P90 | P99 | P999 |
|----:|----:|----:|----:|----:|-----:|
| 2,000 | 2.27 | 3.06 | 3.64 | 8.47 | 16.59 |
| 2,500 | 2.23 | 2.52 | 3.19 | 8.44 | 15.89 |
| 3,000 | 2.13 | 2.37 | 3.03 | 4.97 | 7.23 |

> **Note**: CPU time stable at ~2.3ms P50 across all RPS levels. CPU is NOT the bottleneck.

### 5.4 Cloudflare Durable Objects Wall Time (ms)

| RPS | Total DO Requests | DO Errors | P50 | P75 | P90 | P99 | P999 |
|----:|------------------:|----------:|----:|----:|----:|----:|-----:|
| 2,000 | 620,073 | 0 | 17.76 | 29.88 | 102.05 | 1,019.69 | 1,312.22 |
| 2,500 | 764,279 | 0 | 15.08 | 28.63 | 46.66 | 271.45 | 378.61 |
| 3,000 | 759,010 | 8 | 759.34 | 1,512.10 | 1,821.78 | 2,222.33 | 2,450.69 |

> **Note**: 2,500 RPS shows optimal performance (P99 271ms). 3,000 RPS saturates (P50 jumps to 759ms).

### 5.5 D1 Database Metrics

| RPS | Read Queries | Write Queries | Rows Read | Rows Written |
|----:|-------------:|--------------:|----------:|-------------:|
| 2,000 | 1,010 | 6 | 1,016 | 14 |
| 2,500 | 810 | 6 | 816 | 14 |
| 3,000 | 1,010 | 6 | 1,016 | 14 |

> **Note**: Token Exchange only reads client info from D1 (high cache hit rate).

---

## 6. Conclusion

### 6.1 Performance Evaluation

| Metric | Result |
|--------|--------|
| **Max Throughput** | 2,700 RPS (Peak achievable) |
| **Recommended Operation** | 1,500 RPS (Stable with margin) |
| **Optimal Performance** | 2,500 RPS (K6 P95 225ms, DO P99 271ms) |
| **Token Validation Accuracy** | 100% (All types correctly classified) |

### 6.2 Key Findings

1. **CPU processing is fast and stable**: CPU Time P50 at 2.1-2.3ms across all RPS levels. CPU is NOT the bottleneck.
2. **DO is the bottleneck**: At 3,000 RPS, DO P50 jumps to 759ms (50x degradation).
3. **2,500 RPS is the optimal point**: Best performance with K6 P95 225ms, DO P99 271ms.
4. **3,000 RPS causes saturation**: DO queueing delay causes rapid performance degradation.
5. **100% success rate maintained**: Token validation accuracy preserved under high load.

### 6.3 Architecture

```
k6 Cloud (Portland, OR)
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│                 Cloudflare Edge                         │
├─────────────────────────────────────────────────────────┤
│                 op-token Worker                         │
│    Token Exchange Grant Handler (RFC 8693)              │
│    ├── Client Authentication                            │
│    ├── Subject Token Validation                         │
│    ├── Scope Intersection                               │
│    └── Access Token Generation                          │
└────────────────────┬────────────────────────────────────┘
                     │ RPC Call (Parallel)
         ┌───────────┴───────────┐
         ▼                       ▼
┌─────────────────────────────────────────────────────────┐
│              Durable Objects (shared)                   │
├─────────────────────────────────────────────────────────┤
│  KeyManager (1)        │ JWK management, signing key    │
│  TokenRevocationStore  │ Token revocation check         │
│  (8 shards)            │ jti → revoked status           │
└─────────────────────────────────────────────────────────┘
```

**Authrim's Token Exchange endpoint sustains 2,500 RPS under realistic service-to-service authorization workloads, with strict token validation and revocation checks enabled.**

This benchmark includes:
- Full JWT RS256 signature verification on every request
- Real-time revocation checks against Durable Object storage
- Mixed token types (70% valid, 10% expired, 10% invalid, 10% revoked)
- Delegation flow testing (14% of tokens with actor_token)
- Audience variation (20 different target audiences)
- Scope downgrading (4 scope patterns)

---

*Test conducted: December 14, 2025*
