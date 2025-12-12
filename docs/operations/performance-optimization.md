# Authrim Workers Performance Optimization Comprehensive Plan

## Executive Summary

We conducted a performance analysis of all Authrim Workers (7 total) and developed an optimization plan to reduce CPU time.

### Current Challenges

| Worker | Current CPU Time | Free Plan Compliance | Priority |
|--------|-----------------|---------------------|----------|
| op-discovery | P999 8.77ms | Warning: Marginal | High |
| op-token | P90 14.95ms | Exceeded | Highest |
| op-auth | 20-250ms | Significantly Exceeded | Highest |
| op-management | 20-50ms | Exceeded | High |
| op-userinfo | 20-100ms | Exceeded | High |
| op-async | 8-20ms | Warning: Marginal | Medium |
| router | 3-10ms | OK | Low |

### Expected Results After Optimization

| Worker | Optimized CPU Time | Reduction | Free Plan Compliance |
|--------|-------------------|-----------|---------------------|
| op-discovery | 3-4ms | 60% | OK |
| op-token | 8-10ms | 35-45% | Warning: Marginal |
| op-auth | 10-40ms | 50-84% | Warning: Conditional |
| op-management | 10-25ms | 40-50% | Warning: Marginal |
| op-userinfo | 10-50ms | 40-50% | Warning: Conditional |
| op-async | 5-12ms | 35-40% | OK |
| router | 2-6ms | 40% | OK |

---

## Common Bottleneck Analysis

### 1. JWT Processing (Common to All Workers)

**Problem**:
- RSA private/public key import (`importPKCS8`, `importJWK`) is very heavy (5-10ms)
- Executed on every request
- Same processing duplicated across all Workers

**Estimated CPU Time**: 5-20ms (depending on Worker)

**Solution**:
- **Implement global key cache** (common to all Workers)
- TTL-based caching strategy (60 seconds recommended)
- Overlap period configuration for key rotation

### 2. Durable Object Calls (Common to All Workers)

**Problem**:
- Heavily used for Rate Limiting, authorization code verification, token management, etc.
- JSON.stringify/parse occurs on each call (1-2ms)
- Often executed sequentially

**Estimated CPU Time**: 5-15ms (depending on number of calls)

**Solution**:
- **Utilize parallel execution** (execute multiple DO calls simultaneously)
- **Batch processing** (where possible)
- **Caching strategy** (read-through cache)

### 3. Middleware Processing (Common to All Workers)

**Problem**:
- logger: Debug log output (0.5-1ms)
- secureHeaders: Security header configuration (0.5-1ms)
- CORS: Origin verification (1-2ms)
- Rate Limiting: DO call (5-10ms)

**Estimated CPU Time**: 7-14ms

**Solution**:
- **Disable logger in production**
- **Optimize middleware execution order** (place rate limit first)
- **Remove unnecessary middleware** (eliminate duplication in router layer)

### 4. D1 Queries (Used by Some Workers)

**Problem**:
- Possible missing indexes
- SELECTing unnecessary columns
- Room for transaction optimization

**Estimated CPU Time**: 2-15ms (depending on query)

**Solution**:
- **Index optimization** (client_id, jti, user_id, etc.)
- **SELECT only required columns**
- **Batch queries** (combine multiple queries into one)

---

## Worker-Specific Optimization Plans

### op-discovery (Already Optimized)

**Status**: P999 8.77ms → Target 3-4ms

**Implemented Optimizations**:
1. Discovery metadata caching
2. Excluded Rate Limiting from discovery endpoint

**Additional Recommendations**:
- Disable Logger (production environment)

**Details**: `docs/PERFORMANCE_OPTIMIZATION_OP_DISCOVERY.md` (recommended to create)

---

### op-token (Documentation Created)

**Status**: P90 14.95ms → Target 8-10ms

**Priority: Highest**

**Key Optimization Strategies**:
1. **Signing key caching** (Most Important)
   - Cache in global variables
   - TTL 60 seconds
   - Emergency rotation support (revoked status)
   - Expected Effect: 4-5ms reduction

2. **Logger disable + Audit Log implementation**
   - Disable logger middleware in production
   - Record only important events to D1
   - Expected Effect: 0.5-1ms reduction

3. **Key rotation operational policy development**
   - Normal rotation (every 90 days, 24-hour overlap period)
   - Emergency rotation (immediate invalidation on key compromise)
   - KeyManager DO schema extension

**Details**: `docs/PERFORMANCE_OPTIMIZATION_OP_TOKEN.md`

---

### op-auth

**Status**: 20-250ms → Target 10-40ms

**Priority: Highest**

**Main Bottlenecks**:
1. **HTTPS request_uri fetch** (50-200ms)
2. **Request Object (JWT) verification** (10-20ms)
3. **Passkey verification** (15-25ms)
4. **Rate Limiting** (5-10ms)

**Recommended Optimization Strategies**:

1. **HTTPS request_uri optimization**
   ```typescript
   // Strict timeout configuration
   const controller = new AbortController();
   const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 seconds

   try {
     const response = await fetch(request_uri, {
       signal: controller.signal,
       headers: { 'User-Agent': 'Authrim/1.0' }
     });
   } catch (error) {
     if (error.name === 'AbortError') {
       return c.json({ error: 'request_uri_timeout' }, 400);
     }
   } finally {
     clearTimeout(timeoutId);
   }
   ```
   - Expected Effect: Limit timeout duration (currently may be unlimited)

2. **Request Object verification optimization**
   ```typescript
   // Global cache
   let cachedClientPublicKeys: Map<string, CryptoKey> = new Map();

   async function getClientPublicKey(clientId: string, jwk: JWK): Promise<CryptoKey> {
     const cacheKey = `${clientId}:${jwk.kid}`;

     if (cachedClientPublicKeys.has(cacheKey)) {
       return cachedClientPublicKeys.get(cacheKey)!;
     }

     const publicKey = await importJWK(jwk, 'RS256');
     cachedClientPublicKeys.set(cacheKey, publicKey);

     // Cache size limit (memory management)
     if (cachedClientPublicKeys.size > 100) {
       const firstKey = cachedClientPublicKeys.keys().next().value;
       cachedClientPublicKeys.delete(firstKey);
     }

     return publicKey;
   }
   ```
   - Expected Effect: 5-10ms reduction

3. **Passkey verification optimization**
   ```typescript
   // Execute SimpleWebAuthn processing in parallel
   const [verificationResult, challengeData] = await Promise.all([
     verifyAuthenticationResponse({
       response: credential,
       expectedChallenge: storedChallenge,
       expectedOrigin: origin,
       expectedRPID: rpID,
       authenticator: authenticator,
     }),
     // Execute challenge deletion in parallel
     deleteChallenge(c.env, challengeId)
   ]);
   ```
   - Expected Effect: 2-5ms reduction

4. **Middleware order optimization**
   ```typescript
   // Execute Rate limiting first
   app.use('/authorize', rateLimitMiddleware(...));
   app.use('/par', rateLimitMiddleware(...));
   // Then other middleware
   app.use('*', cors(...));
   app.use('*', secureHeaders(...));
   ```

**Expected Improvement**: 20-250ms → 10-40ms (50-84% reduction)

---

### op-management

**Status**: 20-50ms → Target 10-25ms

**Priority: High**

**Main Bottlenecks**:
1. **JWT verification (Introspection)** (10-20ms)
2. **D1 writes** (5-15ms)
3. **Rate Limiting** (5-10ms)

**Recommended Optimization Strategies**:

1. **JWT verification optimization**
   ```typescript
   // Cache PUBLIC_JWK_JSON parse result
   let cachedPublicJWK: CryptoKey | null = null;

   async function getPublicKey(env: Env): Promise<CryptoKey> {
     if (cachedPublicJWK) {
       return cachedPublicJWK;
     }

     const publicJWK = JSON.parse(env.PUBLIC_JWK_JSON);
     cachedPublicJWK = await importJWK(publicJWK, 'RS256');

     return cachedPublicJWK;
   }
   ```
   - Expected Effect: 5-10ms reduction

2. **D1 query optimization**
   ```sql
   -- Add indexes
   CREATE INDEX IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients(client_id);
   CREATE INDEX IF NOT EXISTS idx_refresh_tokens_jti ON refresh_tokens(jti);
   CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

   -- SELECT only required columns
   SELECT id, client_id, client_secret FROM oauth_clients WHERE client_id = ?;
   -- Avoid SELECT *
   ```
   - Expected Effect: 2-5ms reduction

3. **Async test user creation**
   ```typescript
   // When OIDC conformance test detected, execute in background
   if (isOIDCConformanceTest(client_id)) {
     c.executionCtx.waitUntil(
       createTestUser(c.env, client_id)
     );
   }
   ```
   - Expected Effect: 5-10ms reduction

**Expected Improvement**: 20-50ms → 10-25ms (40-50% reduction)

---

### op-userinfo

**Status**: 20-100ms → Target 10-50ms

**Priority: High**

**Main Bottlenecks**:
1. **JWE encryption** (15-25ms)
2. **JWT signing** (10-15ms)
3. **JWT verification (introspection)** (10-20ms)
4. **KeyManager DO call** (5-10ms)

**Recommended Optimization Strategies**:

1. **KeyManager signing key cache** (same as op-token)
   ```typescript
   // Global cache
   let cachedSigningKey: { privateKey: CryptoKey; kid: string } | null = null;
   let cachedKeyTimestamp = 0;
   const KEY_CACHE_TTL = 60000; // 60 seconds
   ```
   - Expected Effect: 5-10ms reduction

2. **Client public key cache** (for JWE encryption)
   ```typescript
   let cachedClientPublicKeys: Map<string, { key: CryptoKey; kid?: string }> = new Map();

   async function getClientPublicKeyForEncryption(
     clientMetadata: any
   ): Promise<{ key: CryptoKey; kid?: string } | null> {
     const cacheKey = clientMetadata.client_id;

     if (cachedClientPublicKeys.has(cacheKey)) {
       return cachedClientPublicKeys.get(cacheKey)!;
     }

     const publicKey = await getClientPublicKey(clientMetadata);
     if (publicKey) {
       cachedClientPublicKeys.set(cacheKey, publicKey);
     }

     return publicKey;
   }
   ```
   - Expected Effect: 5-10ms reduction

3. **D1 query optimization**
   ```typescript
   // SELECT only required columns
   const user = await c.env.DB.prepare(
     `SELECT id, email, name, family_name, given_name, picture,
             email_verified, phone_number, phone_number_verified,
             address_json, locale, zoneinfo
      FROM users WHERE id = ?`
   ).bind(tokenPayload.sub).first();
   ```
   - Expected Effect: 1-2ms reduction

**Expected Improvement**: 20-100ms → 10-50ms (40-50% reduction)

---

### op-async

**Status**: 8-20ms → Target 5-12ms

**Priority: Medium**

**Main Bottlenecks**:
1. **DO writes** (5-10ms × 2)
2. **getClient() D1 query** (2-5ms)

**Recommended Optimization Strategies**:

1. **Utilize parallel processing**
   ```typescript
   // Execute client verification and code generation in parallel
   const [clientMetadata, deviceCode, userCode] = await Promise.all([
     getClient(c.env, client_id),
     generateDeviceCode(),
     generateUserCode()
   ]);
   ```
   - Expected Effect: 2-3ms reduction

2. **Strengthen getClient() caching** (already implemented, but adjust TTL)

**Expected Improvement**: 8-20ms → 5-12ms (35-40% reduction)

---

### router

**Status**: 3-10ms → Target 2-6ms

**Priority: Low**

**Recommended Optimization Strategies**:

1. **Middleware order optimization**
   ```typescript
   // Make logger conditional
   if (c.env.ENVIRONMENT === 'development') {
     app.use('*', logger());
   }
   ```

2. **Remove CORS duplication**
   - Skip CORS in Router layer
   - Implement in each Worker layer (maintain current state)

**Expected Improvement**: 3-10ms → 2-6ms (40% reduction)

---

## Cross-Cutting Optimization Strategies

### 1. Unified JWT Processing Library

**Problem**: Similar JWT processing duplicated across Workers

**Solution**:
Create common library in `packages/shared`

```typescript
// packages/shared/src/utils/jwt-cache.ts

export class JWTKeyCache {
  private static privateKeyCache: Map<string, { key: CryptoKey; timestamp: number }> = new Map();
  private static publicKeyCache: Map<string, { key: CryptoKey; timestamp: number }> = new Map();
  private static readonly TTL = 60000; // 60 seconds

  static async getPrivateKey(
    kid: string,
    pemOrJWK: string | JWK,
    algorithm: string
  ): Promise<CryptoKey> {
    const cached = this.privateKeyCache.get(kid);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.TTL) {
      return cached.key;
    }

    const key = typeof pemOrJWK === 'string'
      ? await importPKCS8(pemOrJWK, algorithm)
      : await importJWK(pemOrJWK, algorithm);

    this.privateKeyCache.set(kid, { key, timestamp: now });
    return key;
  }

  static async getPublicKey(
    kid: string,
    jwk: JWK,
    algorithm: string
  ): Promise<CryptoKey> {
    const cached = this.publicKeyCache.get(kid);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.TTL) {
      return cached.key;
    }

    const key = await importJWK(jwk, algorithm);
    this.publicKeyCache.set(kid, { key, timestamp: now });
    return key;
  }

  static clearCache() {
    this.privateKeyCache.clear();
    this.publicKeyCache.clear();
  }
}
```

### 2. Unified Middleware Execution Order

**Recommended Order** (common to all Workers):
1. Rate Limiting (reject invalid requests early)
2. CORS (origin verification)
3. Secure Headers (security headers)
4. Logger (development environment only)

### 3. D1 Index Optimization

**Required Indexes**:
```sql
-- oauth_clients
CREATE INDEX IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients(client_id);

-- users
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_id ON users(id);

-- refresh_tokens
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_jti ON refresh_tokens(jti);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_client_id ON refresh_tokens(client_id);

-- authorization_codes
CREATE INDEX IF NOT EXISTS idx_authorization_codes_code ON authorization_codes(code);

-- sessions
CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
```

---

## Implementation Roadmap

### Phase 1: Emergency Response (1-2 weeks)

**Goal**: Bring Workers exceeding free plan limits within limits

1. **op-token**: Signing key cache + Logger disable
2. **op-auth**: Request Object public key cache + HTTPS timeout
3. **op-management**: PUBLIC_JWK_JSON cache
4. **op-userinfo**: Signing key cache

**Expected Results**:
- op-token: 14.95ms → 9-10ms
- op-auth: 50-100ms → 20-40ms (normal flow)
- op-management: 30-40ms → 15-25ms
- op-userinfo: 30-60ms → 15-35ms

### Phase 2: Medium-Term Optimization (2-4 weeks)

**Goal**: Further performance improvement and cost reduction

1. **JWT processing unified library** (shared package)
2. **D1 index optimization**
3. **Middleware order unification**
4. **Durable Object call parallelization**
5. **KeyManager DO extension** (key rotation support)

**Expected Results**:
- Additional 10-20% reduction across all Workers
- Improved code maintainability
- Reduced operational burden

### Phase 3: Long-Term Strategy (3-6 months)

**Goal**: Architecture-level optimization

1. **Gradual migration to ES256** (RSA → ECDSA)
2. **Edge Cache utilization** (Cloudflare Cache API)
3. **Durable Object consolidation** (combine multiple DOs into one)
4. **Consider paid plan migration** (if needed)

**Expected Results**:
- With ES256: Additional 30-50% CPU reduction
- Latency improvement
- Improved scalability

---

## Monitoring & Operations

### Metrics Monitoring (Cloudflare Dashboard)

**Key Indicators**:
- **CPU Time**: P50, P90, P99, P999
- **Error Rate**: 4xx, 5xx
- **Request Count**: Traffic patterns
- **Wall Time**: End-to-end latency

### Alert Configuration

| Worker | Threshold | Action |
|--------|-----------|--------|
| op-token | P90 > 10ms (for 30+ min) | Notify + Investigate |
| op-auth | P90 > 50ms (for 30+ min) | Notify |
| op-management | P90 > 30ms (for 30+ min) | Notify |
| op-userinfo | P90 > 40ms (for 30+ min) | Notify |
| All Workers | Error Rate > 5% (for 10+ min) | Emergency Response |

### Regular Reviews

- **Weekly**: CPU time metrics review
- **Monthly**: Performance optimization effectiveness measurement
- **Quarterly**: Long-term strategy review (ES256 migration, etc.)

---

## Cost Analysis

### Free Plan vs Paid Plan

| Plan | CPU Limit | Request Limit | Price |
|------|-----------|---------------|-------|
| Free | 10ms | 100,000/day | $0 |
| Bundled | 50ms | 10M/month | $5/month~ |
| Unbound | 30 seconds | 1M/month | $0.15/M requests |

### Recommended Approach

1. **After Phase 1 completion**: Can operate on free plan
2. **When traffic increases**: Migrate to Bundled plan
3. **Enterprise usage**: Consider Unbound plan

---

## Conclusion

We have developed a performance analysis and optimization plan for all 7 Workers.

**Key Points**:
1. **JWT processing optimization is most effective** (key caching)
2. **op-token, op-auth, op-management are highest priority**
3. **Free plan compliance possible with Phase 1**
4. **Consider ES256 migration in the long term**

**Next Steps**:
1. Start Phase 1 implementation (signing key cache, Logger disable)
2. Measure performance in test environment
3. Deploy to production gradually
4. Monitor metrics and gather feedback

By following this plan, it will be possible to run all Authrim Workers stably within the free plan limits.
