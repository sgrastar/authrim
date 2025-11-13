# Enrai Performance Benchmark Results

**Test Date:** 2025-11-12
**Test Time:** 00:04:39
**Issuer:** https://enrai.sgrastar.workers.dev
**Test Environment:** Production (Cloudflare Workers)
**Tester:** Automated Script

---

## Test Configuration

- **Tool:** curl with time measurements
- **Measurements:** Response time, DNS lookup, TCP connect, TLS handshake, Time to First Byte (TTFB)
- **Test Runs:** 10 iterations per endpoint (best, worst, average)
- **Target Metrics:**
  - p95 Latency: <50ms (edge)
  - JWT Signing: <10ms (estimated)
  - Total Request: <100ms (with cold start)

---

## Test Results

### Discovery Endpoint

**Endpoint:** `https://enrai.sgrastar.workers.dev/.well-known/openid-configuration`

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| **Min Response Time** | 89ms | - | - |
| **Max Response Time** | 344ms | - | - |
| **Average Response Time** | 207ms | <100ms | ⚠️ REVIEW |
| **p95 Response Time** | 302ms | <50ms | ⚠️ REVIEW |
| **Iterations** | 10 | - | - |

**Sample Breakdown (Last Run):**
- DNS Lookup: ms
- TCP Connect: ms
- TLS Handshake: 33ms
- Time to First Byte: 152ms
- Total: 152ms

---

### JWKS Endpoint

**Endpoint:** `https://enrai.sgrastar.workers.dev/.well-known/jwks.json`

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| **Min Response Time** | 69ms | - | - |
| **Max Response Time** | 330ms | - | - |
| **Average Response Time** | 165ms | <100ms | ⚠️ REVIEW |
| **p95 Response Time** | 298ms | <50ms | ⚠️ REVIEW |
| **Iterations** | 10 | - | - |

**Sample Breakdown (Last Run):**
- DNS Lookup: ms
- TCP Connect: ms
- TLS Handshake: 34ms
- Time to First Byte: 69ms
- Total: 69ms

---

### Authorization Endpoint (Error Response)

**Endpoint:** `https://enrai.sgrastar.workers.dev/authorize?response_type=code&client_id=test&redirect_uri=https://example.com/callback`

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| **Min Response Time** | 56ms | - | - |
| **Max Response Time** | 207ms | - | - |
| **Average Response Time** | 103ms | <100ms | ⚠️ REVIEW |
| **p95 Response Time** | 180ms | <50ms | ⚠️ REVIEW |
| **Iterations** | 10 | - | - |

**Sample Breakdown (Last Run):**
- DNS Lookup: ms
- TCP Connect: ms
- TLS Handshake: 31ms
- Time to First Byte: 89ms
- Total: 89ms

---

### UserInfo Endpoint (Error Response)

**Endpoint:** `https://enrai.sgrastar.workers.dev/userinfo`

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| **Min Response Time** | 61ms | - | - |
| **Max Response Time** | 129ms | - | - |
| **Average Response Time** | 76ms | <100ms | ✅ PASS |
| **p95 Response Time** | 91ms | <50ms | ⚠️ REVIEW |
| **Iterations** | 10 | - | - |

**Sample Breakdown (Last Run):**
- DNS Lookup: ms
- TCP Connect: ms
- TLS Handshake: 38ms
- Time to First Byte: 61ms
- Total: 61ms

---

## Summary

### Performance Targets

| Target | Status | Notes |
|--------|--------|-------|
| p95 Latency <50ms (edge) | See individual results | Cloudflare Workers edge deployment |
| Average Latency <100ms | See individual results | Including cold starts |
| JWT Operations <10ms | Estimated from total latency | Cannot measure directly without instrumentation |

### Key Findings

1. **Discovery Endpoint:**
   - Static JSON response, should have the best performance
   - Benefits from Cloudflare edge caching

2. **JWKS Endpoint:**
   - Returns public key from environment variable
   - Minimal computation required

3. **Authorization Endpoint:**
   - Tested with invalid request (no state parameter)
   - Tests error handling performance

4. **UserInfo Endpoint:**
   - Tested without authorization header
   - Tests authentication check performance

### Recommendations

1. **Cold Start Optimization:**
   - Consider implementing edge caching for Discovery and JWKS endpoints
   - Current implementation may experience cold starts on first request

2. **JWT Performance:**
   - JWT signing performance cannot be measured directly without code instrumentation
   - Consider adding performance monitoring in Phase 4

3. **Regional Performance:**
   - Current tests run from a single location
   - Consider multi-region testing for global latency validation

4. **Load Testing:**
   - Current tests use sequential requests
   - Consider implementing concurrent load tests in Phase 4

---

**Test Completed:** 2025-11-12 00:04:54
**Results File:** docs/conformance/test-results/performance-results-20251112-000439.md
**Phase:** Phase 3 Completion

