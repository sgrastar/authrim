# Storage Consistency Design - Phase 6

**Created**: 2025-11-15
**Last Updated**: 2025-11-16 (v7.0 - DO Integration Complete)
**Branch**: claude/storage-consistency-audit-012q29GoqGNjumv1NvkAMUEA
**Status**: Implementation Complete (All DO Integration Complete)

---

## Executive Summary

Authrim Phase 5's storage architecture effectively combines various Cloudflare Workers storage primitives (Durable Objects, D1, KV), but a **comprehensive audit from 7 perspectives** identified **24 issues** (v5.0 - final audit completed 2025-11-15).

**v6.0 Update**: Considering the product characteristics as an OP, decided on **full Durable Objects migration** strategy. By migrating 5 KV-related issues (#6, #8, #11, #12, #21) that cannot be fully resolved through operations/documentation to DO, we achieve **full RFC/OIDC compliance** and **100% consistency guarantee**.

### 🔴 Release Blockers (CRITICAL - 9 issues)

**Security Vulnerabilities**:
1. **client_secret timing attack** - client_secret guessable via timing attack (#15)
2. **/revoke, /introspect authentication missing** - OAuth 2.0 RFC 7009/7662 violation (#16)

**DO Persistence Lacking (affecting 75% of DOs)**:
3. **SessionStore DO** - All users forced logout on DO restart (#9)
4. **RefreshTokenRotator DO** - Complete token family loss (#4)
5. **AuthorizationCodeStore DO** - OAuth flow failure (#10)

**DO Not Used (implemented but unused)**:
6. **RefreshTokenRotator completely unused** - 300+ lines wasted, non-atomic operations (#17)
7. **Authorization code KV race** - PKCE verification bypass possible (#3)

**WebAuthn/Data Integrity**:
8. **Passkey Counter race** - WebAuthn spec violation (#7)
9. **D1 write retry missing** - Data loss risk (#1)

### 🟠 High Risk (HIGH - 2 issues)

10. **KV cache invalidation window** - stale data served (#2)
11. **D1 cleanup job missing** - unbounded storage growth (1000 DAU → 120k sessions/year) (#18)

### 🟡 Medium Risk (MEDIUM - 7 issues)

**OIDC Compliance**:
12. **auth_time claim missing** - spec violation when using max_age (#19)
13. **userinfo hardcoded data** - unusable in production (#23)

**Data Integrity**:
14. **Magic Link/Passkey challenge reuse** - replay attack possibility (#21)
15. **Partial failure risk** - orphaned records, non-retryable (#22)
16. **Audit log reliability** - compliance risk (#5)

**Other**:
17. ~~**PAR request_uri race** - RFC 9126 violation (low probability) (#11)~~ ✅ **Implementation Complete** - PARRequestStore DO integration
18. **Session batch delete N+1** - performance degradation (#24)

### 🔵 Low Risk/Other (6 issues)

19. ~~DPoP JTI race (#12 - LOW)~~ ✅ **Implementation Complete** - DPoPJTIStore DO integration
20. ~~Session token race (#8 - MEDIUM)~~ ✅ **Implementation Complete** - ChallengeStore DO integration
21. ~~Rate Limiting accuracy (#6 - ACCEPTED)~~ ✅ **Implementation Complete** - RateLimiterCounter DO integration
22. ~~JWKS/KeyManager inconsistency (#13 - DESIGN)~~ ✅ **Implementation Complete** - JWKS Endpoint dynamic retrieval
23. ~~Schema version management (#14 - FUTURE)~~ ✅ **Implementation Complete** - Migration tracking & DO versioning
24. password_reset_tokens (#20 - confirmed, no issues)

---

### 📊 Audit Statistics (v5.0)

- **Audit Methodology**: 7 perspectives (Security, Data Integrity, Concurrency, API Compliance, Operations, Edge Cases, Performance)
- **Check Items**: 70+
- **Files Reviewed**: 18+ (4 DOs, 13 APIs, Utils, Migrations)
- **Total Issues**: 24 issues
- **Severity**: CRITICAL×9, HIGH×2, MEDIUM×7, Other×6

### 🎯 Systematic Patterns

1. **DO persistence lacking**: 75% of DOs (RefreshTokenRotator, SessionStore, AuthCodeStore) not using `state.storage`
2. **DO implementation unused**: AuthCodeStore, RefreshTokenRotator implemented but using KV directly
3. **Non-atomic operations**: KV get-use-delete pattern in 4 places
4. **Basic security mistakes**: Timing attacks, missing authentication

### ⏱️ Total Effort Estimation

- **Phase 1 (P0 Required)**: 14-18 days
- **Phase 2 (P1/P2 Recommended)**: 5-7 days
- **Phase 3 (P3 Optimization)**: 2-3 days
- **Total**: **21-28 days** (approximately 4-6 weeks)

### 🚀 Shortest Release Path

**After Phase 1 completion**: Release possible in 16-20 days (security fixes required)

This document presents specific solutions and implementation strategies for all these issues.

---

## 1. Current Status Analysis and Issues

### 1.1 DO to D1 Writes (Reliability Issue)

#### Current Implementation

**File**: `packages/shared/src/durable-objects/SessionStore.ts:239-257`

```typescript
async createSession(userId: string, ttl: number, data?: SessionData): Promise<Session> {
  const session: Session = {
    id: this.generateSessionId(),
    userId,
    expiresAt: Date.now() + ttl * 1000,
    createdAt: Date.now(),
    data,
  };

  // 1. Store in memory (hot)
  this.sessions.set(session.id, session);

  // 2. Persist to D1 (backup & audit) - async, don't wait
  this.saveToD1(session).catch((error) => {
    console.error('SessionStore: Failed to save to D1:', error);
  });

  return session;
}
```

#### Issues

```
Data Flow:
┌─────────────────┐
│ Create Session  │
└────────┬────────┘
         │
         ├──────────────────────┬─────────────────────┐
         ▼                      ▼                     ▼
   [Immediate]            [Async, don't wait]    [Return Response]
   Save to memory ✅      D1 write ⚠️             To client
         │                      │                     │
         │              Success/failure unknown       │
         │              Error log only                │
         └──────────────────────┴─────────────────────┘
                    Inconsistency possible
```

**Scope of Impact**:
- Session creation: `createSession()` - line 252
- Session extension: `extendSession()` - line 340
- Session invalidation: `invalidateSession()` - line 268

**Specific Risks**:
1. **Data loss**: D1 write fails but exists in memory → lost on Worker restart
2. **Missing audit trail**: Cannot meet compliance requirements
3. **hot/cold inconsistency**: Stale data or null returned when falling back to D1
4. **Silent failure**: Error logged but no operational alert

---

### 1.2 KV Cache Invalidation (Consistency Window)

#### Current Implementation

**File**: `packages/shared/src/storage/adapters/cloudflare-adapter.ts:207-214`

```typescript
private async setToD1WithKVCache(key: string, value: string): Promise<void> {
  // 1. Update D1
  await this.setToD1(key, value);

  // 2. Invalidate KV cache
  if (this.env.CLIENTS_CACHE) {
    await this.env.CLIENTS_CACHE.delete(key);
  }
}
```

#### Issues

```
Timeline:
T0: Client update request received
T1: D1 write starts
T2: D1 write completes ✅
    ↓
   [Consistency window - problem period]
    ↓
    Concurrent request A: Get cache from KV → return stale data ❌
    Concurrent request B: Get cache from KV → return stale data ❌
    ↓
T3: KV delete starts
T4: KV delete completes ✅
T5: Next request: KV miss → fetch new data from D1 → recache to KV ✅
```

**Scope of Impact**:
- Client metadata updates
- Old URI may be accepted when redirect_uri changes
- Scope changes not reflected (max 5 minutes = KV TTL)

**Specific Scenario**:
```
1. Admin updates client redirect_uris
   Old: ["https://old.example.com/callback"]
   New: ["https://new.example.com/callback"]

2. Between D1 update complete (T2) → KV delete starts (T3)

3. Authorization request arrives:
   - redirect_uri: https://old.example.com/callback
   - Get stale metadata from KV
   - Validation succeeds ❌ (should fail)
   - Authorization code issued ❌

4. Security risk: Authorization code sent to old redirect URI
```

---

### 1.3 Authorization Code KV Usage (Security Risk)

#### Current Implementation

**File**: `packages/shared/src/utils/kv.ts:36-65`

```typescript
export async function storeAuthCode(env: Env, code: string, data: AuthCodeData): Promise<void> {
  const ttl = parseInt(env.CODE_EXPIRY, 10);
  const expirationTtl = ttl; // TTL in seconds

  await env.AUTH_CODES.put(code, JSON.stringify(data), {
    expirationTtl,
  });
}

export async function getAuthCode(env: Env, code: string): Promise<AuthCodeData | null> {
  const data = await env.AUTH_CODES.get(code);
  // ... omitted
}
```

#### Issues

**KV Consistency Model**:
- Cloudflare KV is **Eventually Consistent**
- Not immediately synchronized between multiple edge locations
- May have up to 60 seconds delay after write

**OAuth 2.0 Security Requirements**:
- RFC 6749: Authorization code is **one-time use** (can only be used once)
- Security BCP Draft 16: Invalidate all tokens when reuse detected

**Race Condition Scenario**:
```
When attacker intercepts authorization code:

T0: Legitimate client: Gets code
T1: Attacker: Sends same code to Edge Location A
T2: Legitimate client: Sends to Edge Location B

Concurrent processing:
┌──────────────────────┐       ┌──────────────────────┐
│ Edge Location A      │       │ Edge Location B      │
│ (Attacker's request) │       │ (Legitimate request) │
└──────────────────────┘       └──────────────────────┘
         │                              │
         ▼                              ▼
   KV.get(code)                   KV.get(code)
   → found ✅                      → found ✅
         │                              │
         ▼                              ▼
   Issue token ❌                 Issue token ✅
   (Attack success)               (Legitimate)
         │                              │
         ▼                              ▼
   KV.delete(code)                KV.delete(code)

Result: Both requests succeed → OAuth 2.0 violation
```

**Existing Solution**:
- `AuthorizationCodeStore` Durable Object **already implemented**
- File: `packages/shared/src/durable-objects/AuthorizationCodeStore.ts`
- However, **unused** (not used in authorize.ts, token.ts)

---

### 1.4 Additional Consistency Issues (Found in Comprehensive Audit)

The following issues were discovered through detailed audit of the entire codebase.

#### Issue 4: RefreshTokenRotator Persistence Lacking (Critical)

**Location**: `packages/shared/src/durable-objects/RefreshTokenRotator.ts:99-100`

```typescript
export class RefreshTokenRotator {
  private state: DurableObjectState;
  private env: Env;
  private families: Map<string, TokenFamily> = new Map(); // ← Memory only
  private tokenToFamily: Map<string, string> = new Map(); // ← Memory only
  // ...
}
```

**Issues**:
- Token families stored **in memory only**
- `KeyManager` uses `this.state.storage.put()` for persistence, but `RefreshTokenRotator` doesn't
- **All token families lost** on Durable Object restart (deployment, error, Worker migration, etc.)

**Impact**:
```
User Flow:
1. User logs in → Refresh Token issued
2. Token Family created → saved in RefreshTokenRotator memory
3. Worker restart (e.g., new version deployment)
4. Memory cleared → all Token Families lost
5. User attempts access with Refresh Token
6. Token Family not found → authentication fails ❌
7. User forced logout

Result: All users must re-login
```

**Comparison - KeyManager's Correct Implementation**:

`packages/shared/src/durable-objects/KeyManager.ts:75-112`

```typescript
export class KeyManager {
  private keyManagerState: KeyManagerState | null = null;

  private async initializeState(): Promise<void> {
    // Load from Durable Storage ✅
    const stored = await this.state.storage.get<KeyManagerState>('state');
    if (stored) {
      this.keyManagerState = stored;
    }
  }

  private async saveState(): Promise<void> {
    // Persist to Durable Storage ✅
    await this.state.storage.put('state', this.keyManagerState);
  }
}
```

**Solution**:
- RefreshTokenRotator should also use `state.storage.put()` / `get()`
- Persist token families to Durable Storage
- Restore on restart

---

#### Issue 5: Audit Log Reliability (Compliance Risk)

**Location**: `packages/shared/src/durable-objects/RefreshTokenRotator.ts:191-215`

```typescript
private async logToD1(entry: AuditLogEntry): Promise<void> {
  if (!this.env.DB) {
    return;
  }

  try {
    await this.env.DB.prepare(/* INSERT INTO audit_log ... */).run();
  } catch (error) {
    console.error('RefreshTokenRotator: D1 audit log error:', error);
    // Don't throw - audit logging failure should not break rotation
    // ↑ Error is ignored ⚠️
  }
}
```

**Issues**:
- Same problem as `SessionStore`: Audit log is async, failures ignored
- **Security events** like token theft detection and family invalidation may not be logged
- Cannot meet compliance requirements (SOC 2, GDPR, etc.)

**Scope of Impact**:
```
SessionStore:
- Session create/extend/invalidate
- Processing continues even on audit log failure

RefreshTokenRotator:
- Token rotation
- Theft detection ← Particularly critical
- Family invalidation
- All potentially failing audit log

Total: All authentication & authorization events
```

**Compliance Requirements**:
```
SOC 2 (System and Organization Controls 2):
- CC6.1: Record all access attempts
- CC7.2: Monitor and record security events

GDPR (General Data Protection Regulation):
- Article 30: Record processing activities
- Article 33: Record data breaches

OAuth 2.0 Security BCP:
- Section 4.13: Record all token operations
```

**Solution**:
- Apply retry queue from Section 2.1 to audit logs as well
- Or write audit logs synchronously (consistency level: `strong`)
- Send alerts on audit log failure

---

#### Problem 6: Rate Limiting Accuracy Issues

**Location**: `packages/shared/src/middleware/rate-limit.ts:63-106`

```typescript
async function checkRateLimit(env, clientIP, config) {
  const key = `ratelimit:${clientIP}`;

  // Step 1: Read
  const recordJson = await env.STATE_STORE.get(key);
  let record: RateLimitRecord;

  if (recordJson) {
    record = JSON.parse(recordJson);
    // Step 2: Modify
    record.count++;
  } else {
    record = { count: 1, resetAt: now + config.windowSeconds };
  }

  // Step 3: Write
  await env.STATE_STORE.put(key, JSON.stringify(record), {
    expirationTtl: config.windowSeconds + 60,
  });

  const allowed = record.count <= config.maxRequests;
  return { allowed, ... };
}
```

**Problem**: Read-Modify-Write Race Condition

```
Example of concurrent requests:
T0: Current count = 5 (KV)

T1: Request A: KV.get() → count = 5
T2: Request B: KV.get() → count = 5 (still reading old value)

T3: Request A: count++ → 6
T4: Request B: count++ → 6 (should be 7)

T5: Request A: KV.put(count=6)
T6: Request B: KV.put(count=6) ← Overwrites

Result: count = 6 (should be 7)
```

**Impact**:
- Rate limiting is inaccurate
- Attackers can potentially bypass limits
- DDoS protection is ineffective

**KV Constraints**:
- Cloudflare KV uses eventual consistency
- No Compare-and-Swap (CAS) functionality
- No atomic increment operations

**Solutions**:
```
Option 1: Durable Objects for Rate Limiting
- Use when strong consistency is required
- DO instance per IP address (sharding)
- Guarantees atomic counting

Option 2: Durable Objects Alarms + KV
- DO for counting (accurate)
- KV for caching (performance)
- Periodic synchronization

Option 3: Accept Imprecision (Current State)
- Treat rate limiting as "best effort"
- Accept some level of inaccuracy
- Keep it simple with KV-based approach
```

---

#### Problem 7: Passkey Counter Race Condition (Potential WebAuthn Spec Violation)

**Location**: `packages/shared/src/storage/adapters/cloudflare-adapter.ts:819-829`

```typescript
async updateCounter(passkeyId: string, counter: number): Promise<Passkey> {
  const now = Math.floor(Date.now() / 1000);

  // Step 1: D1 UPDATE (overwrite with new counter)
  await this.adapter.execute(
    'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?',
    [counter, now, passkeyId]
  );

  // Step 2: SELECT (retrieve update result)
  const results = await this.adapter.query<Passkey>(
    'SELECT * FROM passkeys WHERE id = ?',
    [passkeyId]
  );

  return results[0];
}
```

**WebAuthn Specification Requirements**:

[WebAuthn Level 2 Specification, Section 7.2](https://www.w3.org/TR/webauthn-2/#sctn-authenticator-data)

> The signature counter's value MUST be strictly increasing. If the stored counter value is greater than or equal to the received counter value, the credential has been cloned.

**Problem**:
```
Example of concurrent authentication requests:
DB state: counter = 10

T1: User logs in from Device A
    → Authenticator returns counter = 11
    → updateCounter(passkeyId, 11)

T2: User logs in from Device B (simultaneously)
    → Authenticator returns counter = 12
    → updateCounter(passkeyId, 12)

T3: Request A: UPDATE counter = 11 WHERE id = ...
T4: Request B: UPDATE counter = 12 WHERE id = ... (overwrites)

Result: counter = 12 ✅

T5: User logs in again from Device A
    → Authenticator returns counter = 13
    → DB counter = 12 → 13 > 12 → OK ✅

No problem? → No, if the order is reversed:

T1: Request B: UPDATE counter = 12
T2: Request A: UPDATE counter = 11 (overwrites) ← Problem!

Result: counter = 11 ❌

T3: User logs in from Device B again
    → Authenticator returns counter = 13
    → DB counter = 11 → 13 > 11 → OK (should detect cloned credential)
```

**Correct Implementation**:

```typescript
// Compare-and-Swap pattern
async updateCounter(passkeyId: string, newCounter: number): Promise<Passkey> {
  // Step 1: Get current counter
  const current = await this.adapter.query<Passkey>(
    'SELECT counter FROM passkeys WHERE id = ?',
    [passkeyId]
  );

  if (!current[0]) {
    throw new Error('Passkey not found');
  }

  // Step 2: Only update if new counter is greater
  if (newCounter <= current[0].counter) {
    throw new Error('Invalid counter: possible credential clone');
  }

  // Step 3: Conditional UPDATE
  const result = await this.adapter.execute(
    'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND counter = ?',
    [newCounter, Math.floor(Date.now() / 1000), passkeyId, current[0].counter]
  );

  // Step 4: Verify update succeeded (check if another request updated first)
  if (result.changes === 0) {
    // Another request updated first → Retry
    return await this.updateCounter(passkeyId, newCounter);
  }

  // Success
  return await this.get(passkeyId);
}
```

---

#### Problem 8: Session Token (KV) Race Condition

**Location**: `packages/op-auth/src/session-management.ts:140-165`

```typescript
// Step 1: Get token from KV
const tokenData = await kvStore.get(tokenKey);
if (!tokenData) {
  return c.json({ error: 'Invalid token' }, 400);
}

const parsed = JSON.parse(tokenData);

// Step 2: Check if already used
if (parsed.used) {
  return c.json({ error: 'Token already used' }, 400);
}

// Step 3: Mark as used
parsed.used = true;
await kvStore.put(tokenKey, JSON.stringify(parsed), {
  expirationTtl: 60,
});
```

**Problem**: Same Read-Check-Set race condition as AuthorizationCode

```
Concurrent requests:
T1: Request A: KV.get(token) → used = false
T2: Request B: KV.get(token) → used = false (still reading old value)

T3: Request A: used = true → KV.put()
T4: Request B: used = true → KV.put()

Result: Both requests succeed ❌
```

**Impact**:
- ITP (Intelligent Tracking Prevention) compatible session tokens can be reused
- Security risk

**Solutions**:
- Manage session tokens with Durable Objects as well
- Or minimize impact with extremely short TTL (currently: 5 minutes)

---

#### Problem 9: SessionStore DO Lacks Persistence (Critical) ⚠️ Newly Discovered

**Location**: `packages/shared/src/durable-objects/SessionStore.ts:72`

```typescript
export class SessionStore {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Map<string, Session> = new Map(); // ← In-memory only ❌
  // ...
}
```

**Problem**:
- SessionStore has the **same issue** as `RefreshTokenRotator`
- Session data is stored **in-memory only**, does not use `state.storage.put/get()`
- D1 writes are fire-and-forget (duplicates Problem 1)
- **All active sessions are lost** when Durable Object restarts

**Impact Scope**:
```
User Impact:
1. User logs in → Session created
2. SessionStore saves to memory (+ attempts D1 write)
3. Worker restart (deployment, scaling, failure, etc.)
4. Memory cleared → All sessions lost
5. User attempts to access
6. Session not found → Authentication fails ❌
7. **All users are force logged out**

Additional problems:
- If D1 write failed, D1 fallback also fails
- hot/cold pattern completely dysfunctional
```

**Data Flow Analysis**:
```
Current state (problematic):
┌──────────────┐
│ Create Session │
└──────┬───────┘
       │
       ├─────────────┬──────────────┐
       ▼             ▼              ▼
   [Memory Save] [D1 Write]    [Response]
    ✅ Instant   ⚠️ async       ✅ Returned
       │        .catch()           │
       │        Ignored            │
       │                          │
   [DO Restart]                  │
       │                          │
       ▼                          │
    All Lost ❌                    │
       │                          │
   [Read from D1]                │
       │                          │
       ▼                          │
   Also Failed ❌ ← If D1 write failed
```

**Comparison with KeyManager**:

SessionStore (problematic):
```typescript
// Line 72: In-memory only
private sessions: Map<string, Session> = new Map();

// Line 252-254: Fire-and-forget
this.saveToD1(session).catch((error) => {
  console.error('SessionStore: Failed to save to D1:', error);
});
```

KeyManager (correct implementation):
```typescript
// Uses Durable Storage
private keyManagerState: KeyManagerState | null = null;

private async initializeState(): Promise<void> {
  const stored = await this.state.storage.get<KeyManagerState>('state');
  if (stored) {
    this.keyManagerState = stored;
  }
}

private async saveState(): Promise<void> {
  await this.state.storage.put('state', this.keyManagerState);
}
```

**Solutions**:
1. Refactor SessionStore to use `KeyManager` pattern
2. Persist sessions using `state.storage.put/get()`
3. Use D1 only for audit backup (optional)
4. Restore from Durable Storage on restart

---

#### Problem 10: AuthorizationCodeStore DO Lacks Persistence (Critical) ⚠️ Newly Discovered

**Location**: `packages/shared/src/durable-objects/AuthorizationCodeStore.ts:83`

```typescript
export class AuthorizationCodeStore {
  private state: DurableObjectState;
  private env: Env;
  private codes: Map<string, AuthorizationCode> = new Map(); // ← In-memory only ❌
  // ...
}
```

**Problem**:
- AuthorizationCodeStore **was created as a solution to Problem 3**, yet still has **persistence issues**
- Authorization codes are stored **in-memory only**, does not use `state.storage.put/get()`
- **Additional issue**: This DO is implemented but not actually being used!
  - `op-token/src/token.ts` still uses KV-based `getAuthCode()`
  - `op-auth/src/consent.ts` does use AuthorizationCodeStore DO (correct)
  - **Inconsistency**: Two implementations coexist

**Impact Scope**:
```
OAuth 2.0 Flow:
1. User authorizes → Authorization code issued
2. AuthorizationCodeStore saves to memory
3. Worker restart (can occur within 60-second TTL)
4. Memory cleared → Authorization code lost
5. Client sends code to token endpoint
6. Code not found → Token acquisition fails ❌
7. Entire OAuth flow fails

Impact Level:
- Limited impact due to short TTL (60 seconds)
- However, 100% failure if DO restart occurs at the wrong time
```

**Ironic Situation**:
```
Problem 3: Race condition from using KV
     ↓
Solution: Created AuthorizationCodeStore DO ✅
     ↓
New Problem: DO lacks persistence ❌
     ↓
Additionally: Still actually using KV ❌

Result: Solution implemented but not used, and has new problems
```

**Code Evidence**:

AuthorizationCodeStore (created but not used):
```typescript
// packages/shared/src/durable-objects/AuthorizationCodeStore.ts:83
private codes: Map<string, AuthorizationCode> = new Map(); // In-memory only
```

Token endpoint (using old KV implementation):
```typescript
// packages/op-token/src/token.ts:180
const authCodeData = await getAuthCode(c.env, validCode);

// packages/op-token/src/token.ts:461
await markAuthCodeAsUsed(c.env, validCode, {...}); // KV race condition (Problem 3)
```

Consent endpoint (using new DO implementation):
```typescript
// packages/op-auth/src/consent.ts:252-253
const codeStoreId = c.env.AUTH_CODE_STORE.idFromName(code);
const codeStore = c.env.AUTH_CODE_STORE.get(codeStoreId);
```

**Solutions**:
1. Implement `state.storage.put/get()` in AuthorizationCodeStore
2. **Migrate Token endpoint to use AuthorizationCodeStore** (highest priority)
3. Deprecate KV-based `getAuthCode()`/`markAuthCodeAsUsed()`

---

#### Problem 11: PAR request_uri Single-Use Guarantee Race Condition (Medium) ⚠️ Newly Discovered

**Location**: `packages/op-auth/src/authorize.ts:92-142`

```typescript
// Step 1: Get request_uri data from KV
const requestData = await c.env.STATE_STORE.get(`request_uri:${request_uri}`);

if (!requestData) {
  return c.json({ error: 'Invalid or expired request_uri' }, 400);
}

// ... Use data ...

// Step 2: Delete for single-use (RFC 9126 requirement)
await c.env.STATE_STORE.delete(`request_uri:${request_uri}`);
```

**Problem**: Race condition from KV get → use → delete pattern

```
Example of concurrent requests:
T1: Request A: KV.get(`request_uri:urn:...`) → Data retrieved ✅
T2: Request B: KV.get(`request_uri:urn:...`) → Data retrieved ✅ (not yet deleted)

T3: Request A: Use data → Generate authorization code
T4: Request B: Use data → Generate authorization code

T5: Request A: KV.delete()
T6: Request B: KV.delete()

Result: Two authorization codes generated from same request_uri ❌
```

**RFC 9126 Violation**:

[RFC 9126: OAuth 2.0 Pushed Authorization Requests, Section 2.3](https://datatracker.ietf.org/doc/html/rfc9126#section-2.3)

> The request_uri MUST be bound to the client that posted the authorization request. The request_uri MUST be one-time use and MUST be short lived.

**Attack Scenario**:
```
1. Attacker obtains valid request_uri (from PAR endpoint)
2. Sends two authorization requests simultaneously:
   - Request A: /authorize?request_uri=urn:...
   - Request B: /authorize?request_uri=urn:...
3. Depending on timing, both succeed
4. Two authorization codes are issued
5. Attacker uses one, saves the other

Impact:
- Violation of single-use guarantee
- Security risk (limited)
```

**Impact Assessment**:
- **Severity**: Medium (not Critical)
- **Reasons**:
  1. Attack requires precise timing
  2. request_uri has short lifetime (600 seconds)
  3. Requires network-level MitM or client control
  4. Authorization code itself is also single-use (separate protection)

**Current Mitigations**:
- Short PAR expiration (600 seconds)
- Authorization code's own single-use guarantee (noted in Problem 3)
- HTTPS transport protection

**Solution Options**:

Option 1: Durable Object for PAR
```typescript
// PAR RequestStore DO (new)
class PARRequestStore {
  private requests: Map<string, RequestData> = new Map();

  async consumeRequest(requestUri: string): Promise<RequestData | null> {
    const data = this.requests.get(requestUri);
    if (!data) return null;

    // Atomically delete
    this.requests.delete(requestUri);
    return data;
  }
}
```

Option 2: KV Compare-and-Swap (future feature)
```typescript
// Cloudflare KV CAS (not currently available)
const success = await c.env.STATE_STORE.compareAndSwap(
  `request_uri:${request_uri}`,
  null, // expected value (after delete)
  requestData, // current value
);
```

Option 3: Accept Current State (recommended)
```
Reasons:
- High attack difficulty
- Limited actual impact
- Protected by other security layers
- Complexity vs risk tradeoff

Actions:
- Documentation only
- Monitoring (detect multiple uses of same request_uri)
```

---

### 1.5 Issues Discovered in Final Audit (v5.0)

Multi-faceted v5.0 audit (7 perspectives, 70+ checklist items) identified the following **13 new issues**:

#### Problem #12: DPoP JTI Replay Protection Race Condition (LOW)

**Details**: See existing document v3.0

#### Problem #15: Client Secret Timing Attack Vulnerability (CRITICAL) ⚠️

**File**: `packages/op-auth/src/logout.ts:216`

**Current Implementation**:
```typescript
// ❌ Vulnerable to timing attacks
if (!client || client.client_secret !== secret) {
  return c.json({ error: 'invalid_client' }, 401);
}
```

**Problem**:
- Uses plain string comparison (`!==`)
- Comparison time depends on number of matching characters
- client_secret can be statistically inferred via timing attack

**Attack Scenario**:
```
1. Attacker attempts authentication with multiple client_secret candidates
2. Measures processing time for each attempt (microsecond precision)
3. Processing time varies based on number of matching characters with correct secret
4. Statistical analysis infers secret one character at a time
5. Secret identified after thousands to tens of thousands of attempts
```

**Impact Scope**:
- All client authentication endpoints
- logout.ts, token.ts, revoke.ts, introspect.ts

**Fix Proposal**:
```typescript
import { timingSafeEqual } from 'crypto';

// ✅ Constant-time comparison
const secretBuffer = Buffer.from(client.client_secret, 'utf8');
const providedBuffer = Buffer.from(secret, 'utf8');

if (secretBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(secretBuffer, providedBuffer)) {
  return c.json({ error: 'invalid_client' }, 401);
}
```

**Effort**: 0.5 days (replace all instances with `timingSafeEqual()`)

---

#### Problem #16: Missing Client Authentication in /revoke and /introspect (CRITICAL) ⚠️

**Files**:
- `packages/op-management/src/revoke.ts:86-96`
- `packages/op-management/src/introspect.ts:88-98`

**Current Implementation**:
```typescript
// revoke.ts
const clientIdValidation = validateClientId(client_id);
if (!clientIdValidation.valid) {
  return c.json({ error: 'invalid_client' }, 401);
}
// ⚠️ client_secret validation is completely missing!
```

**RFC Violations**:
- **RFC 7009 Section 2.1**: "The client MUST authenticate with the authorization server"
- **RFC 7662 Section 2.1**: "The protected resource MUST authenticate with the authorization server"

**Impact**:
- Any client can revoke tokens of other clients
- Any client can introspect tokens of other clients
- Complete collapse of OAuth 2.0 security model

**Attack Scenario**:
```
1. Attacker obtains valid client_id (public information)
2. Intercepts or guesses another client's access_token
3. POST /revoke with client_id=victim&token=stolen_token
4. Executes successfully without authentication → Token revoked
```

**Fix Proposal**:
```typescript
// Add client_secret validation
const client = await getClient(c.env, client_id);
if (!client) {
  return c.json({ error: 'invalid_client' }, 401);
}

// Timing-attack-safe comparison
if (!timingSafeEqual(
  Buffer.from(client.client_secret),
  Buffer.from(client_secret)
)) {
  return c.json({ error: 'invalid_client' }, 401);
}
```

**Effort**: 1 day

---

#### Problem #17: RefreshTokenRotator DO Completely Unused (CRITICAL) ⚠️

**Files**:
- `packages/shared/src/durable-objects/RefreshTokenRotator.ts` (300+ lines)
- `packages/op-token/src/token.ts`

**Current Implementation**:
```typescript
// token.ts doesn't use RefreshTokenRotator, directly uses KV
await storeRefreshToken(c.env, refreshTokenJti, {...});  // → KV
const refreshTokenData = await getRefreshToken(c.env, jti);  // → KV
await deleteRefreshToken(c.env, jti);  // → KV
```

**Problems**:
- RefreshTokenRotator's atomic operations are dysfunctional
- Refresh token rotation is non-atomic
- Token family detection is dysfunctional
- 300+ lines of code completely wasted

**Root Cause**:
- DO is implemented but actual usage points remain with KV
- Same pattern as AuthCodeStore (Problem #10)

**Impact**:
- Token reuse attacks cannot be detected
- Violation of RFC 6749 security requirements

**Fix**: Migrate token.ts to use RefreshTokenRotator DO (address together with Problem #4)

**Effort**: 1-2 days

---

#### Problem #18: Missing D1 Cleanup Jobs (HIGH) ⚠️

**Location**: Overall Architecture

**Problems**:
- No automatic deletion of expired data
- **sessions**: Expired sessions accumulate infinitely
- **password_reset_tokens**: Used/expired tokens accumulate
- **audit_log**: Audit logs grow infinitely

**Data Growth Projection**:
```
Assumptions: 1000 DAU, average 10 sessions/user/month

After 1 year:
- sessions: 120,000 records
- password_reset_tokens: 36,500 records (100 resets/day)
- audit_log: 3,650,000 records (10k events/day)

Impact:
- Increased storage costs
- Degraded query performance
- Reduced index efficiency
```

**Recommended Implementation**:
```typescript
// Cloudflare Workers Cron Trigger
export default {
  async scheduled(event: ScheduledEvent, env: Env) {
    const now = Math.floor(Date.now() / 1000);

    // Delete expired sessions (daily)
    await env.DB.prepare(
      'DELETE FROM sessions WHERE expires_at < ?'
    ).bind(now - 86400).run(); // 1 day grace period

    // Delete expired password reset tokens (daily)
    await env.DB.prepare(
      'DELETE FROM password_reset_tokens WHERE expires_at < ? OR used = 1'
    ).bind(now).run();

    // Archive old audit logs (every Sunday)
    if (event.cron === '0 0 * * 0') {
      // Export logs older than 90 days to R2, then delete
      // TODO: Audit log archiving process
    }
  }
};
```

**Cron Configuration**:
```toml
# wrangler.toml
[triggers]
crons = ["0 2 * * *"]  # Daily at 2:00 AM UTC
```

**Effort**: 1-2 days

---

#### Problem #19: Missing auth_time Claim in ID Token (MEDIUM)

**File**: `packages/op-token/src/token.ts:389-395`

**Current Implementation**:
```typescript
const idTokenClaims = {
  iss: c.env.ISSUER_URL,
  sub: authCodeData.sub,
  aud: client_id,
  nonce: authCodeData.nonce,
  at_hash: atHash,
  // auth_time is missing ❌
};
```

**OIDC Core Specification**:
- Section 2: "`auth_time` - Time when the End-User authentication occurred"
- Section 3.1.3.3: "REQUIRED when max_age parameter is used"
- Section 5.5.1: "Recommended to include even when not required"

**Impact**:
- Specification violation when max_age parameter is used
- Client cannot verify authentication time
- Session management functionality is limited

**Fix Proposal**:
```typescript
const idTokenClaims = {
  iss: c.env.ISSUER_URL,
  sub: authCodeData.sub,
  aud: client_id,
  nonce: authCodeData.nonce,
  at_hash: atHash,
  auth_time: authCodeData.auth_time || Math.floor(Date.now() / 1000), // Added
};
```

**Prerequisite**: Authentication time must be saved in authCodeData

**Effort**: 0.5 days

---

#### Problem #21: Passkey/Magic Link Challenge Reuse Vulnerability (MEDIUM)

**Files**:
- `packages/op-auth/src/passkey.ts:162,252,372,472`
- `packages/op-auth/src/magic-link.ts:224,283`

**Pattern**:
```typescript
// Magic Link
const tokenData = await c.env.MAGIC_LINKS.get(`token:${token}`, 'json');
// ... use token ...
await c.env.MAGIC_LINKS.delete(`token:${token}`);
```

**Problems**:
- KV get → use → delete pattern (non-atomic)
- Same challenge/token can be used multiple times in concurrent requests

**Attack Scenario**:
```
1. Attacker intercepts valid magic link URL
2. Sends two concurrent requests
3. Both successfully KV get (before delete)
4. Both requests authenticate successfully
5. Multiple sessions are created
```

**Mitigating Factors**:
- Magic Link: 15-minute TTL, delivered via email
- Passkey Challenge: 5-minute TTL
- Attack success requires precise timing

**Fix Options**:
1. Convert to Durable Object (atomic operations)
2. Documentation only (considering mitigating factors)

**Effort**: 2 days (DO conversion) or documentation only

---

#### Problem #22: Partial Failure Risk in Magic Link/Passkey Registration (MEDIUM)

**Files**:
- `packages/op-auth/src/magic-link.ts:257-283`
- `packages/op-auth/src/passkey.ts:229-252`

**Pattern**:
```typescript
// Magic Link Verify (multiple steps, no transaction)
await c.env.DB.prepare('UPDATE users SET email_verified = 1, ...').run();  // Step 1
await sessionStore.fetch(...);  // Step 2: Create session
await c.env.MAGIC_LINKS.delete(`token:${token}`);  // Step 3: Delete token
```

**Problems**:
- If Step 2 fails: Token already deleted, user cannot retry
- If Step 1 fails: User is verified but has no authentication info
- Orphaned records, inconsistent state

**Occurrence Scenario**:
```
1. User clicks magic link
2. DB UPDATE succeeds (email_verified = 1)
3. SessionStore DO times out
4. Token already deleted, user cannot retry
5. User is verified but cannot log in
```

**Recommended Actions**:
- Execute in reverse order (deletion last)
- Add retry logic
- Clarify transaction boundaries

**Effort**: 1-2 days

---

#### Problem #23: userinfo Endpoint Returns Hardcoded Data (MEDIUM)

**File**: `packages/op-userinfo/src/userinfo.ts:82-111`

**Current Implementation**:
```typescript
// Static user data for MVP
// In production, fetch from user database based on sub
const userData = {
  name: 'Test User',
  family_name: 'User',
  given_name: 'Test',
  // ... hardcoded test data
};
```

**Issues**:
- All users receive the same userinfo
- OIDC compliance violation (should return actual user data)
- Not usable in production environment

**Proposed Fix**:
```typescript
// Fetch user data from D1
const user = await c.env.DB.prepare(
  'SELECT * FROM users WHERE id = ?'
).bind(sub).first();

if (!user) {
  return c.json({ error: 'invalid_token' }, 401);
}

const userData = {
  name: user.name,
  email: user.email,
  email_verified: user.email_verified === 1,
  // ... fetched from D1
};
```

**Effort**: 1 day

---

#### Problem #24: N+1 DO Calls in Bulk Session Deletion (MEDIUM)

**File**: `packages/op-management/src/admin.ts:1012-1023`

**Current Implementation**:
```typescript
await Promise.all(
  data.sessions.map(async (session) => {
    const deleteResponse = await sessionStore.fetch(
      new Request(`https://session-store/session/${session.id}`, {
        method: 'DELETE',
      })
    );
  })
);
```

**Issues**:
- 100 sessions → 100 DO HTTP calls
- Increased latency, concentrated DO load
- Cost increase (billed per DO call)

**Recommended Action**:
```typescript
// Add batch delete API to SessionStore DO
async deleteBatch(sessionIds: string[]): Promise<void> {
  for (const id of sessionIds) {
    this.sessions.delete(id);
  }
  await this.state.storage.deleteAll(sessionIds.map(id => `session:${id}`));
}

// Caller side
await sessionStore.fetch(
  new Request('https://session-store/sessions/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ sessionIds: data.sessions.map(s => s.id) })
  })
);
```

**Effort**: 1 day

---

#### Other Issues

**Problem #20**: password_reset_tokens used flag
- **Status**: ✅ Confirmed, no issues
- Schema contains `used INTEGER DEFAULT 0`

**Problem #13**: JWKS Endpoint and KeyManager inconsistency
- **Details**: See existing document v3.0

**Problem #14**: Schema version management missing
- **Details**: See existing document v3.0

---

## 2. Solution Design

### 2.1 Ensuring DO to D1 Reliability

#### Design Strategy

**Strategy**: Write-Behind Queue with Retry Logic

```
┌─────────────────────────────────────────────────────────┐
│              Write-Behind Queue Pattern                  │
└─────────────────────────────────────────────────────────┘

Main Flow:
1. Write to memory (immediate)
2. Add to write queue
3. Return response
4. D1 write in background (with retry)

Implementation:
┌──────────────┐
│ Client Request│
└───────┬───────┘
        │
        ▼
┌────────────────────┐
│ SessionStore DO    │
│                    │
│ ┌────────────────┐ │
│ │ 1. Memory Write│ │ ← Immediate completion
│ └────────┬───────┘ │
│          │         │
│          ▼         │
│ ┌────────────────┐ │
│ │ 2. Queue Add   │ │ ← Lightweight operation
│ └────────┬───────┘ │
└──────────┼─────────┘
           │
           ▼
    Response to Client ✅
           │
           │ [Background processing]
           ▼
┌───────────────────────┐
│ Retry Queue Worker    │
│                       │
│ ┌──────────────────┐  │
│ │ 3. D1 Write      │  │
│ └────┬─────────────┘  │
│      │                │
│      ├─ Success → Remove from queue
│      │                │
│      └─ Failure → Exponential backoff
│         ├─ Retry #1: After 1 second
│         ├─ Retry #2: After 2 seconds
│         ├─ Retry #3: After 4 seconds
│         ├─ Retry #4: After 8 seconds
│         └─ Max 5 retries → Alert
└───────────────────────┘
```

#### Implementation Details

**1. Adding Retry Queue**

```typescript
// packages/shared/src/durable-objects/SessionStore.ts

interface QueuedWrite {
  id: string;
  operation: 'create' | 'update' | 'delete';
  session: Session;
  attempts: number;
  nextRetry: number;
}

export class SessionStore {
  private sessions: Map<string, Session> = new Map();
  private writeQueue: Map<string, QueuedWrite> = new Map(); // New addition
  private processingQueue: boolean = false;

  // ... existing code ...

  private async queueD1Write(
    operation: 'create' | 'update' | 'delete',
    session: Session
  ): Promise<void> {
    const queueId = `${operation}_${session.id}_${Date.now()}`;

    this.writeQueue.set(queueId, {
      id: queueId,
      operation,
      session,
      attempts: 0,
      nextRetry: Date.now(),
    });

    // Start background processing (async, don't wait for result)
    if (!this.processingQueue) {
      void this.processWriteQueue();
    }
  }

  private async processWriteQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    while (this.writeQueue.size > 0) {
      const now = Date.now();

      for (const [queueId, queued] of this.writeQueue.entries()) {
        // Check retry timing
        if (queued.nextRetry > now) {
          continue;
        }

        try {
          // Execute D1 write
          switch (queued.operation) {
            case 'create':
            case 'update':
              await this.saveToD1(queued.session);
              break;
            case 'delete':
              await this.deleteFromD1(queued.session.id);
              break;
          }

          // Success → Remove from queue
          this.writeQueue.delete(queueId);
          console.log(`SessionStore: D1 ${queued.operation} succeeded for ${queued.session.id}`);

        } catch (error) {
          // Failure → Retry strategy
          queued.attempts++;

          if (queued.attempts >= 5) {
            // Maximum retry count exceeded → Alert
            console.error(
              `SessionStore: D1 ${queued.operation} failed after ${queued.attempts} attempts for ${queued.session.id}`,
              error
            );

            // TODO: Send alert to external monitoring system
            // await this.sendAlert('D1_WRITE_FAILURE', { queueId, queued, error });

            // Move to dead letter queue (optional)
            this.writeQueue.delete(queueId);
          } else {
            // Exponential backoff: 2^attempts seconds
            const backoffSeconds = Math.pow(2, queued.attempts);
            queued.nextRetry = now + backoffSeconds * 1000;

            console.warn(
              `SessionStore: D1 ${queued.operation} failed (attempt ${queued.attempts}/5), retrying in ${backoffSeconds}s`,
              error
            );
          }
        }
      }

      // If all items have nextRetry > now, pause
      const nextItem = Array.from(this.writeQueue.values())
        .sort((a, b) => a.nextRetry - b.nextRetry)[0];

      if (nextItem && nextItem.nextRetry > now) {
        const waitTime = nextItem.nextRetry - now;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      // If queue is empty, exit
      if (this.writeQueue.size === 0) {
        break;
      }
    }

    this.processingQueue = false;
  }

  async createSession(userId: string, ttl: number, data?: SessionData): Promise<Session> {
    const session: Session = {
      id: this.generateSessionId(),
      userId,
      expiresAt: Date.now() + ttl * 1000,
      createdAt: Date.now(),
      data,
    };

    // 1. Save to memory (immediate)
    this.sessions.set(session.id, session);

    // 2. Add D1 write to queue (lightweight operation)
    await this.queueD1Write('create', session);

    return session;
  }

  async extendSession(sessionId: string, additionalSeconds: number): Promise<Session | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    session.expiresAt += additionalSeconds * 1000;
    this.sessions.set(sessionId, session);

    // Add to queue
    await this.queueD1Write('update', session);

    return session;
  }

  async invalidateSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    const hadSession = this.sessions.has(sessionId);
    this.sessions.delete(sessionId);

    if (session) {
      // Add to queue
      await this.queueD1Write('delete', session);
    }

    return hadSession;
  }
}
```

**2. Monitoring and Alerts**

```typescript
// packages/shared/src/utils/monitoring.ts (new file)

export interface Alert {
  type: 'D1_WRITE_FAILURE' | 'KV_CACHE_FAILURE' | 'AUTH_CODE_RACE';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

export async function sendAlert(env: Env, alert: Alert): Promise<void> {
  // Implementation options:
  // 1. Cloudflare Workers Logging (console.error with structured data)
  console.error('ALERT:', JSON.stringify(alert));

  // 2. Cloudflare Workers Analytics Engine
  if (env.ANALYTICS) {
    await env.ANALYTICS.writeDataPoint({
      blobs: [alert.type, alert.severity],
      doubles: [alert.timestamp],
      indexes: [alert.type],
    });
  }

  // 3. External monitoring services (Sentry, Datadog, etc.)
  // await fetch('https://monitoring-service.example.com/alerts', {
  //   method: 'POST',
  //   body: JSON.stringify(alert),
  // });
}
```

**3. Explicit Consistency Levels**

```typescript
// packages/shared/src/storage/interfaces.ts

export type ConsistencyLevel = 'strong' | 'eventual';

export interface WriteOptions {
  consistency?: ConsistencyLevel;
  timeout?: number; // milliseconds
}

export interface ISessionStore {
  create(session: Partial<Session>, options?: WriteOptions): Promise<Session>;
  extend(sessionId: string, seconds: number, options?: WriteOptions): Promise<Session | null>;
  delete(sessionId: string, options?: WriteOptions): Promise<void>;
}
```

**Usage Example**:
```typescript
// Critical session (write to D1 immediately)
await sessionStore.create(session, { consistency: 'strong', timeout: 5000 });

// Regular session (async write)
await sessionStore.create(session, { consistency: 'eventual' });
```

---

### 2.2 KV Cache Invalidation Strategy

#### Design Approach

**Strategy**: Delete-Then-Write Pattern

```
┌─────────────────────────────────────────────────────┐
│         Delete-Then-Write Pattern                    │
└─────────────────────────────────────────────────────┘

Traditional (Write-Then-Delete):
T1: D1 write ✅
T2: [Consistency window] ← Problem
T3: KV delete ✅

Improved (Delete-Then-Write):
T1: KV delete ✅ (Remove old cache)
T2: D1 write ✅
T3: Next read → KV miss → Fetch latest from D1 ✅
```

#### Implementation Details

**1. Order Change + Error Handling**

```typescript
// packages/shared/src/storage/adapters/cloudflare-adapter.ts

private async setToD1WithKVCache(key: string, value: string): Promise<void> {
  // Strategy 1: Delete-Then-Write (recommended)

  // Step 1: Delete KV cache first
  if (this.env.CLIENTS_CACHE) {
    try {
      await this.env.CLIENTS_CACHE.delete(key);
    } catch (error) {
      // Cache delete failure only logs (D1 is source of truth)
      console.warn(`KV cache delete failed for ${key}, proceeding with D1 write`, error);
    }
  }

  // Step 2: Write to D1
  await this.setToD1(key, value);

  // This closes the consistency window:
  // - After KV delete: Reads fall back to D1 (slower but correct)
  // - After D1 write: Reads fetch latest data
}
```

**2. Alternative: Compare-and-Swap Pattern**

When higher consistency is required:

```typescript
interface CachedValue {
  data: string;
  version: number; // D1's updated_at timestamp
}

private async setToD1WithKVCache(key: string, value: string): Promise<void> {
  const valueData = JSON.parse(value);
  const version = Date.now();

  // Write to D1 (with version)
  await this.setToD1(key, JSON.stringify({ ...valueData, _version: version }));

  // Save to KV cache with version
  if (this.env.CLIENTS_CACHE) {
    await this.env.CLIENTS_CACHE.put(
      key,
      JSON.stringify({ data: value, version }),
      { expirationTtl: 300 }
    );
  }
}

private async getFromD1WithKVCache(key: string): Promise<string | null> {
  if (this.env.CLIENTS_CACHE) {
    const cached = await this.env.CLIENTS_CACHE.get(key);
    if (cached) {
      const { data, version } = JSON.parse(cached) as CachedValue;

      // Check latest version from D1 (lightweight query)
      const d1Version = await this.getD1Version(key);

      if (d1Version && d1Version <= version) {
        // Cache is latest
        return data;
      }

      // Cache is stale → Delete and refetch
      await this.env.CLIENTS_CACHE.delete(key);
    }
  }

  // KV miss or stale cache → Fetch from D1
  const value = await this.getFromD1(key);

  if (value && this.env.CLIENTS_CACHE) {
    const version = Date.now();
    await this.env.CLIENTS_CACHE.put(
      key,
      JSON.stringify({ data: value, version }),
      { expirationTtl: 300 }
    );
  }

  return value;
}

private async getD1Version(key: string): Promise<number | null> {
  const [table, id] = key.split(':', 2);
  if (table !== 'client') return null;

  const result = await this.env.DB.prepare(
    'SELECT updated_at FROM oauth_clients WHERE client_id = ?'
  )
    .bind(id)
    .first();

  return result ? (result.updated_at as number) : null;
}
```

**3. Cache-Control Headers (Client-Side)**

```typescript
// packages/op-management/src/admin.ts (Client update endpoint)

app.put('/clients/:client_id', async (c) => {
  const clientId = c.req.param('client_id');
  const updates = await c.req.json();

  // Update client
  const updated = await clientStore.update(clientId, updates);

  return c.json(updated, 200, {
    // Cache control headers
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'ETag': `"${updated.updated_at}"`,
    'Last-Modified': new Date(updated.updated_at * 1000).toUTCString(),
  });
});

app.get('/clients/:client_id', async (c) => {
  const clientId = c.req.param('client_id');
  const client = await clientStore.get(clientId);

  if (!client) {
    return c.json({ error: 'Client not found' }, 404);
  }

  // Conditional request support
  const ifNoneMatch = c.req.header('If-None-Match');
  const etag = `"${client.updated_at}"`;

  if (ifNoneMatch === etag) {
    return c.body(null, 304); // Not Modified
  }

  return c.json(client, 200, {
    'Cache-Control': 'private, max-age=300', // 5-minute cache
    'ETag': etag,
    'Last-Modified': new Date(client.updated_at * 1000).toUTCString(),
  });
});
```

---

### 2.3 Authorization Code Durable Object Migration

#### Design Approach

**Enable Existing `AuthorizationCodeStore` DO**

Integrate the currently unused `AuthorizationCodeStore` Durable Object into the authorization flow.

```
Before (KV):
authorize.ts → storeAuthCode(KV) → AUTH_CODES namespace
token.ts → getAuthCode(KV) → Race condition possible ❌

After (DO):
authorize.ts → AuthorizationCodeStore DO → Strong consistency ✅
token.ts → AuthorizationCodeStore DO → One-time use guarantee ✅
```

#### Implementation Details

**1. Authorization Endpoint Changes**

```typescript
// packages/op-auth/src/authorize.ts

// Before:
import { storeAuthCode } from '@repo/shared/utils/kv';

// Generate and store authorization code
const code = crypto.randomUUID();
await storeAuthCode(env, code, {
  clientId,
  redirectUri: validRedirectUri,
  userId: user.id,
  scope,
  codeChallenge,
  codeChallengeMethod,
  nonce,
  state,
});

// After:
// Use AuthorizationCodeStore DO
const doId = env.AUTH_CODE_STORE.idFromName('default');
const doStub = env.AUTH_CODE_STORE.get(doId);

const code = crypto.randomUUID();

const response = await doStub.fetch(
  new Request('http://internal/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      clientId,
      redirectUri: validRedirectUri,
      userId: user.id,
      scope,
      codeChallenge,
      codeChallengeMethod,
      nonce,
      state,
      expiresAt: Date.now() + 60 * 1000, // 60 seconds
    }),
  })
);

if (!response.ok) {
  throw new Error('Failed to store authorization code');
}
```

**2. Token Endpoint Changes**

```typescript
// packages/op-token/src/token.ts

// Before:
import { getAuthCode } from '@repo/shared/utils/kv';

const authCodeData = await getAuthCode(env, code);
if (!authCodeData || authCodeData.used) {
  return c.json({ error: 'invalid_grant' }, 400);
}

// Mark as used
authCodeData.used = true;
await storeAuthCode(env, code, authCodeData);

// After:
// Atomically consume with AuthorizationCodeStore DO
const doId = env.AUTH_CODE_STORE.idFromName('default');
const doStub = env.AUTH_CODE_STORE.get(doId);

const response = await doStub.fetch(
  new Request('http://internal/code/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      clientId,
      codeVerifier, // For PKCE
    }),
  })
);

if (!response.ok) {
  const error = await response.json();

  if (response.status === 409) {
    // Code reuse detected → Revoke all tokens
    console.error('Authorization code reuse detected:', error);

    // TODO: Revoke all tokens issued with this authorization code
    // await revokeTokensByAuthCode(env, code);

    return c.json({
      error: 'invalid_grant',
      error_description: 'Authorization code has already been used',
    }, 400);
  }

  return c.json({ error: 'invalid_grant' }, 400);
}

const authCodeData = await response.json();

// Continue with token issuance...
```

**3. AuthorizationCodeStore DO Extension**

```typescript
// packages/shared/src/durable-objects/AuthorizationCodeStore.ts

export class AuthorizationCodeStore {
  // ... existing code ...

  /**
   * Atomically consume code
   * One-time use guarantee + PKCE validation
   */
  async consumeCode(request: ConsumeCodeRequest): Promise<ConsumeCodeResponse> {
    const { code, clientId, codeVerifier } = request;

    const stored = this.codes.get(code);

    if (!stored) {
      throw new Error('Code not found or expired');
    }

    // Already used → Reuse detected
    if (stored.used) {
      // Security event log
      console.error('SECURITY: Authorization code reuse attempt detected', {
        code,
        clientId,
        originalClientId: stored.clientId,
        timestamp: Date.now(),
      });

      // Audit log
      await this.logToD1('auth_code.reuse_detected', {
        code,
        clientId,
        userId: stored.userId,
      });

      // 409 Conflict
      throw new ConflictError('Authorization code has already been used');
    }

    // Client validation
    if (stored.clientId !== clientId) {
      throw new Error('Client mismatch');
    }

    // PKCE validation
    if (stored.codeChallenge) {
      if (!codeVerifier) {
        throw new Error('Code verifier required');
      }

      const isValid = await this.verifyPKCE(
        codeVerifier,
        stored.codeChallenge,
        stored.codeChallengeMethod
      );

      if (!isValid) {
        throw new Error('Invalid code verifier');
      }
    }

    // Atomically mark as used
    stored.used = true;
    stored.usedAt = Date.now();
    this.codes.set(code, stored);

    // Audit log
    await this.logToD1('auth_code.consumed', {
      code,
      clientId,
      userId: stored.userId,
    });

    return {
      clientId: stored.clientId,
      redirectUri: stored.redirectUri,
      userId: stored.userId,
      scope: stored.scope,
      nonce: stored.nonce,
      state: stored.state,
    };
  }

  private async verifyPKCE(
    verifier: string,
    challenge: string,
    method: 'S256' | 'plain'
  ): Promise<boolean> {
    if (method === 'plain') {
      return verifier === challenge;
    }

    // S256: BASE64URL(SHA256(verifier)) == challenge
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    return base64 === challenge;
  }

  private async logToD1(event: string, metadata: Record<string, unknown>): Promise<void> {
    if (!this.env.DB) return;

    try {
      await this.env.DB.prepare(
        'INSERT INTO audit_log (event, metadata, created_at) VALUES (?, ?, ?)'
      )
        .bind(event, JSON.stringify(metadata), Math.floor(Date.now() / 1000))
        .run();
    } catch (error) {
      console.error('Failed to log to D1:', error);
    }
  }
}
```

**4. Gradual Deprecation of KV AUTH_CODES**

```typescript
// Migration strategy:
// Phase 1: Parallel operation (write to both, prioritize read from DO)
// Phase 2: Write to DO only (with KV read fallback)
// Phase 3: Complete KV removal

// packages/shared/src/utils/kv.ts

export async function storeAuthCodeMigration(
  env: Env,
  code: string,
  data: AuthCodeData,
  useDO: boolean = true
): Promise<void> {
  if (useDO && env.AUTH_CODE_STORE) {
    // New method: Durable Object
    const doId = env.AUTH_CODE_STORE.idFromName('default');
    const doStub = env.AUTH_CODE_STORE.get(doId);
    await doStub.fetch(
      new Request('http://internal/code', {
        method: 'POST',
        body: JSON.stringify({ code, ...data }),
      })
    );
  } else {
    // Old method: KV (backward compatibility)
    await storeAuthCode(env, code, data);
  }
}
```

---

### 2.4 RefreshTokenRotator Persistence

#### Design Approach

**Apply the same Durable Storage pattern as KeyManager**

```typescript
// packages/shared/src/durable-objects/RefreshTokenRotator.ts

export class RefreshTokenRotator {
  private state: DurableObjectState;
  private env: Env;

  // Type definition for state management
  private rotatorState: {
    families: Map<string, TokenFamily>;
    tokenToFamily: Map<string, string>;
  } | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Initialize: Restore state from Durable Storage
   */
  private async initializeState(): Promise<void> {
    if (this.rotatorState !== null) {
      return; // Already initialized
    }

    // Load from Durable Storage
    const storedFamilies = await this.state.storage.get<Array<[string, TokenFamily]>>('families');
    const storedIndex = await this.state.storage.get<Array<[string, string]>>('tokenToFamily');

    this.rotatorState = {
      families: storedFamilies ? new Map(storedFamilies) : new Map(),
      tokenToFamily: storedIndex ? new Map(storedIndex) : new Map(),
    };

    console.log(
      `RefreshTokenRotator initialized: ${this.rotatorState.families.size} families restored`
    );
  }

  /**
   * Save state to Durable Storage
   */
  private async saveState(): Promise<void> {
    if (!this.rotatorState) {
      return;
    }

    await this.state.storage.put('families', Array.from(this.rotatorState.families.entries()));
    await this.state.storage.put(
      'tokenToFamily',
      Array.from(this.rotatorState.tokenToFamily.entries())
    );
  }

  /**
   * Create token family (with persistence)
   */
  async createFamily(request: CreateFamilyRequest): Promise<TokenFamily> {
    // Initialize state
    await this.initializeState();

    const familyId = this.generateFamilyId();
    const now = Date.now();

    const family: TokenFamily = {
      id: familyId,
      currentToken: request.token,
      previousTokens: [],
      userId: request.userId,
      clientId: request.clientId,
      scope: request.scope,
      rotationCount: 0,
      createdAt: now,
      lastRotation: now,
      expiresAt: now + request.ttl * 1000,
    };

    // Save to memory
    this.rotatorState!.families.set(familyId, family);
    this.rotatorState!.tokenToFamily.set(request.token, familyId);

    // Persist to Durable Storage
    await this.saveState();

    // Audit log (async, best effort)
    void this.logToD1({
      action: 'created',
      familyId,
      userId: request.userId,
      clientId: request.clientId,
      metadata: { scope: request.scope },
      timestamp: now,
    });

    return family;
  }

  /**
   * Token rotation (with persistence)
   */
  async rotate(request: RotateTokenRequest): Promise<RotateTokenResponse> {
    await this.initializeState();

    const family = this.findFamilyByToken(request.currentToken);
    if (!family) {
      throw new Error('invalid_grant: Refresh token not found or expired');
    }

    // ... Theft detection logic (same as existing code) ...

    // Generate new token
    const newToken = this.generateToken();

    // Atomic update (in-memory)
    const oldToken = family.currentToken;
    family.previousTokens.push(oldToken);
    family.currentToken = newToken;
    family.rotationCount++;
    family.lastRotation = Date.now();

    // Trim previousTokens
    if (family.previousTokens.length > this.MAX_PREVIOUS_TOKENS) {
      const removed = family.previousTokens.shift();
      if (removed) {
        this.rotatorState!.tokenToFamily.delete(removed);
      }
    }

    // Update memory
    this.rotatorState!.families.set(family.id, family);
    this.rotatorState!.tokenToFamily.set(newToken, family.id);

    // Persist to Durable Storage ✅
    await this.saveState();

    // Audit log (async)
    void this.logToD1({
      action: 'rotated',
      familyId: family.id,
      userId: request.userId,
      clientId: request.clientId,
      metadata: { rotationCount: family.rotationCount },
      timestamp: Date.now(),
    });

    return {
      newToken,
      familyId: family.id,
      expiresIn: Math.floor((family.expiresAt - Date.now()) / 1000),
      rotationCount: family.rotationCount,
    };
  }
}
```

**Benefits**:
- Token families restored after DO restart ✅
- Users not forcibly logged out during deployment ✅
- State retained during Worker migration ✅

**Notes**:
- `state.storage.put()` is asynchronous but consistency is maintained as it's serialized within the DO
- Storage size limit: Durable Storage is 128KB/key (watch out for large numbers of token families)

---

### 2.5 Improving Audit Log Reliability

#### Design Approach

**Option A: Reliability Through Retry Queue**

Apply the `Write-Behind Queue with Retry Logic` from Section 2.1 to audit logs as well.

```typescript
// packages/shared/src/durable-objects/shared/AuditLogQueue.ts (new file)

export interface AuditLogEntry {
  event: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export class AuditLogQueue {
  private queue: Map<string, { entry: AuditLogEntry; attempts: number; nextRetry: number }> =
    new Map();
  private processing: boolean = false;

  constructor(
    private env: Env,
    private onAlert: (alert: Alert) => Promise<void>
  ) {}

  async enqueue(entry: AuditLogEntry): Promise<void> {
    const id = `audit_${crypto.randomUUID()}`;
    this.queue.set(id, {
      entry,
      attempts: 0,
      nextRetry: Date.now(),
    });

    if (!this.processing) {
      void this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    this.processing = true;

    while (this.queue.size > 0) {
      const now = Date.now();

      for (const [id, queued] of this.queue.entries()) {
        if (queued.nextRetry > now) continue;

        try {
          await this.writeToD1(queued.entry);
          this.queue.delete(id); // Success → Delete
        } catch (error) {
          queued.attempts++;

          if (queued.attempts >= 5) {
            // Maximum retry count exceeded → Alert
            await this.onAlert({
              type: 'AUDIT_LOG_FAILURE',
              severity: 'critical',
              message: 'Audit log write failed after 5 attempts',
              metadata: { entry: queued.entry, error },
              timestamp: now,
            });

            this.queue.delete(id); // Move to dead letter queue (implementation omitted)
          } else {
            // Exponential backoff
            queued.nextRetry = now + Math.pow(2, queued.attempts) * 1000;
          }
        }
      }

      // Wait
      const nextItem = Array.from(this.queue.values())
        .sort((a, b) => a.nextRetry - b.nextRetry)[0];

      if (nextItem && nextItem.nextRetry > now) {
        await new Promise((resolve) => setTimeout(resolve, nextItem.nextRetry - now));
      }

      if (this.queue.size === 0) break;
    }

    this.processing = false;
  }

  private async writeToD1(entry: AuditLogEntry): Promise<void> {
    await this.env.DB.prepare(
      'INSERT INTO audit_log (id, user_id, action, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(
        `audit_${crypto.randomUUID()}`,
        entry.userId || null,
        entry.event,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        Math.floor(entry.timestamp / 1000)
      )
      .run();
  }
}

// RefreshTokenRotator usage example
export class RefreshTokenRotator {
  private auditQueue: AuditLogQueue;

  constructor(state: DurableObjectState, env: Env) {
    this.auditQueue = new AuditLogQueue(env, async (alert) => {
      await sendAlert(env, alert);
    });
  }

  async rotate(request: RotateTokenRequest): Promise<RotateTokenResponse> {
    // ... token rotation processing ...

    // Add to audit log queue (async, retry guarantee)
    await this.auditQueue.enqueue({
      event: 'refresh_token.rotated',
      userId: request.userId,
      metadata: { familyId: family.id, rotationCount: family.rotationCount },
      timestamp: Date.now(),
    });

    return result;
  }
}
```

**Option B: Synchronous Auditlog（強consistency）**

Securityevent（Theft detection等）onlySynchronouswrite. 

```typescript
async rotate(request: RotateTokenRequest): Promise<RotateTokenResponse> {
  // ... token rotation processing ...

  if (theftDetected) {
    // Theft detection → Synchronous logwrite（Failed, return Error返却）
    await this.logToD1Sync({
      event: 'refresh_token.theft_detected',
      userId: request.userId,
      metadata: { familyId: family.id },
      timestamp: Date.now(),
    });

    throw new Error('invalid_grant: Token theft detected');
  }

  // normallyrotation → Async log（best effort）
  void this.auditQueue.enqueue({ ... });

  return result;
}

private async logToD1Sync(entry: AuditLogEntry): Promise<void> {
  // With timeoutSync write
  await Promise.race([
    this.writeToD1(entry),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Audit log timeout')), 5000)
    ),
  ]);
}
```

**Recommended**: Option A (Retryqueue) + Option B (ImportanteventSync)Hybrid

---

### 2.6 Rate LimitingDesign Choices

#### Option Comparison

| Option | precision | Performance | Complexity | Cost |
|-----------|------|--------------|-------|-------|
| Option 1: DO | ✅ Perfect | ⚠️ Shardingrequired | High | High |
| Option 2: DO Alarms + KV | ✅ High | ✅ Good | Medium | Medium |
| Option 3: KV (Current) | ⚠️ best effort | ✅ Best | Low | Low |

**Recommended**: Option 3（CurrentMaintain） + Documentation

**Reason**:
- Rate limiting「best effort」in many cases多い
- perfect precisionAlso than, simplicity and low cost priority
- AttackersMultipleIPusefor, Single IP precisionImprovementEffectlimited

**DocumentationAdd**:

```typescript
// packages/shared/src/middleware/rate-limit.ts

/**
 * Rate Limiting Middleware (Best-Effort)
 *
 * This rate limitingimplementation is KV-based, , eventual consistency, not perfect precisionis not guaranteed. 
 * ParallelrequestThanCount不accuratebecomepossibleexist, 以DecreaseReasonThanacceptable range内：
 *
 * 1. Rate limitingMain DDoSCountermeasure (Large number of requests）Purpose, boundary value precisionNot important
 * 2. Attackersnormally, MultipleIP addresses, use for, Single IP precisionImprovement is limited
 * 3. Simple implementationThan, PerformanceCostOptimization
 *
 * Higher precision Rate limiting required case（example: Billing API quotaManagement）, 
 * Durable ObjectsBasedimplementationConsiderしてくさい. 
 */
export function rateLimitMiddleware(config: RateLimitConfig) {
  // ...
}
```

**Alternative (FutureImprovement)**:

Strict precisionrequired caseonly, SpecificendpointDOBaseduse. 

```typescript
// Rate Limit DO (Highprecision版)
export class RateLimitCounter {
  private counts: Map<string, { count: number; resetAt: number }> = new Map();

  async increment(clientIP: string, windowSeconds: number): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    let record = this.counts.get(clientIP);

    if (!record || now >= record.resetAt) {
      record = { count: 1, resetAt: now + windowSeconds };
    } else {
      record.count++;
    }

    this.counts.set(clientIP, record);
    return record.count;
  }
}
```

---

### 2.7 Passkey Counter Compare-and-Swap implementation

#### implementationDetails

```typescript
// packages/shared/src/storage/adapters/cloudflare-adapter.ts

export class PasskeyStore implements IPasskeyStore {
  /**
   * Update passkey counter with compare-and-swap logic
   * Ensures monotonic increase per WebAuthn specification
   */
  async updateCounter(
    passkeyId: string,
    newCounter: number,
    maxRetries: number = 3
  ): Promise<Passkey> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Step 1: Read current counter
        const current = await this.adapter.query<{ counter: number }>(
          'SELECT counter FROM passkeys WHERE id = ?',
          [passkeyId]
        );

        if (!current[0]) {
          throw new Error(`Passkey not found: ${passkeyId}`);
        }

        const currentCounter = current[0].counter;

        // Step 2: Validate monotonic increase
        if (newCounter <= currentCounter) {
          // Counter did not increase → possible credential clone
          console.error('SECURITY: Passkey counter anomaly detected', {
            passkeyId,
            currentCounter,
            newCounter,
          });

          throw new Error(
            `Invalid counter: ${newCounter} <= ${currentCounter}. Possible credential clone.`
          );
        }

        // Step 3: Conditional UPDATE (compare-and-swap)
        const now = Math.floor(Date.now() / 1000);
        const result = await this.adapter.execute(
          `UPDATE passkeys
           SET counter = ?, last_used_at = ?
           WHERE id = ? AND counter = ?`,
          [newCounter, now, passkeyId, currentCounter]
        );

        // Step 4: Check if update succeeded
        if (result.changes === 0) {
          // Another request updated the counter first → retry
          console.warn(
            `Passkey counter update conflict (attempt ${attempt + 1}/${maxRetries})`,
            { passkeyId }
          );

          // Exponential backoff before retry
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 10));
          continue;
        }

        // Success → return updated passkey
        const updated = await this.adapter.query<Passkey>(
          'SELECT * FROM passkeys WHERE id = ?',
          [passkeyId]
        );

        if (!updated[0]) {
          throw new Error(`Passkey disappeared after update: ${passkeyId}`);
        }

        return updated[0];
      } catch (error) {
        if (attempt === maxRetries - 1) {
          // Max retries reached
          throw error;
        }
        // Retry on transient errors
      }
    }

    throw new Error(`Failed to update passkey counter after ${maxRetries} attempts`);
  }
}
```

**WebAuthnSpecificationcompliance**:
- ✅ CounterMonotonicIncreaseguarantee
- ✅ CloneDetection（counterDecreaseWhenError）
- ✅ ParallelrequestSupport（Compare-and-Swap）

---

### 2.8 sessiontokenManagementImprovement

#### Option A: TTLshortening（最alsoSimple）

```typescript
// packages/op-auth/src/session-management.ts

// Current: 5 minutes
const SESSION_TOKEN_TTL = 300;

// Improvement: 30 secondsshortening
const SESSION_TOKEN_TTL = 30;
```

**Benefits**:
- implementationChangesNone
- Race conditionstateImpactMinimize

**Drawbacks**:
- UXLowDecrease（ShortTTLuserRe-authenticationRequiredpossible）
- ITPSupportEssential resolvenot

#### Option B: Durable ObjectManagement（Perfect複雑）

```typescript
// packages/shared/src/durable-objects/SessionTokenStore.ts (new)

export class SessionTokenStore {
  private tokens: Map<string, { sessionId: string; used: boolean; expiresAt: number }> =
    new Map();

  async createToken(sessionId: string, ttl: number): Promise<string> {
    const token = `st_${crypto.randomUUID()}`;
    this.tokens.set(token, {
      sessionId,
      used: false,
      expiresAt: Date.now() + ttl * 1000,
    });
    return token;
  }

  async consumeToken(token: string): Promise<string | null> {
    const tokenData = this.tokens.get(token);

    if (!tokenData || tokenData.used || tokenData.expiresAt <= Date.now()) {
      return null;
    }

    // AtomicuseMark
    tokenData.used = true;
    this.tokens.set(token, tokenData);

    return tokenData.sessionId;
  }
}
```

**Benefits**:
- ✅ Perfect consistency
- ✅ Race conditionstateNone

**Drawbacks**:
- ComplexityIncrease
- CostIncrease

#### Recommended: Option A（TTLshortening + Documentation）

**Reason**:
- sessiontoken一When的 also, perfect precisionRequirednot
- TTLshorteningImpactMinimizeすれば十 minutes
- SimpleさMaintain

---

### 2.9 SessionStore DO persistence implementation（Critical）⚠️ NEW

**strategy**: KeyManagerPatternApply

#### Step 1: Durable StorageInterfaceAdd

```typescript
// packages/shared/src/durable-objects/SessionStore.ts

interface SessionStoreState {
  sessions: Record<string, Session>; // Map → Record for serialization
  lastCleanup: number;
}

export class SessionStore {
  private state: DurableObjectState;
  private env: Env;
  private sessionStoreState: SessionStoreState | null = null;
  private cleanupInterval: number | null = null;

  /**
   * Initialize state from Durable Storage
   */
  private async initializeState(): Promise<void> {
    if (this.sessionStoreState !== null) {
      return;
    }

    // Load from Durable Storage
    const stored = await this.state.storage.get<SessionStoreState>('state');

    if (stored) {
      this.sessionStoreState = stored;
    } else {
      // Initialize empty state
      this.sessionStoreState = {
        sessions: {},
        lastCleanup: Date.now(),
      };
      await this.saveState();
    }

    // Start cleanup interval
    this.startCleanup();
  }

  /**
   * Save state to Durable Storage
   */
  private async saveState(): Promise<void> {
    if (this.sessionStoreState) {
      await this.state.storage.put('state', this.sessionStoreState);
    }
  }

  /**
   * Get session (from Durable Storage, D1 fallback only for migration)
   */
  async getSession(sessionId: string): Promise<Session | null> {
    await this.initializeState();

    const session = this.sessionStoreState!.sessions[sessionId];

    if (session && !this.isExpired(session)) {
      return session;
    }

    // Optional: D1 fallback for migration period only
    // After migration complete, remove this
    if (!session) {
      const d1Session = await this.loadFromD1(sessionId);
      if (d1Session && !this.isExpired(d1Session)) {
        // Promote to Durable Storage
        this.sessionStoreState!.sessions[sessionId] = d1Session;
        await this.saveState();
        return d1Session;
      }
    }

    return null;
  }

  /**
   * Create session (save to Durable Storage)
   */
  async createSession(userId: string, ttl: number, data?: SessionData): Promise<Session> {
    await this.initializeState();

    const session: Session = {
      id: this.generateSessionId(),
      userId,
      expiresAt: Date.now() + ttl * 1000,
      createdAt: Date.now(),
      data,
    };

    // 1. Save to Durable Storage (primary)
    this.sessionStoreState!.sessions[session.id] = session;
    await this.saveState();

    // 2. Optional: Backup to D1 (async, for audit)
    // Keep this for audit trail, but don't rely on it
    this.saveToD1(session).catch((error) => {
      console.error('SessionStore: D1 backup failed:', error);
      // Trigger alert for audit log failure
    });

    return session;
  }

  /**
   * Invalidate session (remove from Durable Storage)
   */
  async invalidateSession(sessionId: string): Promise<boolean> {
    await this.initializeState();

    const hadSession = !!this.sessionStoreState!.sessions[sessionId];

    // Remove from Durable Storage
    delete this.sessionStoreState!.sessions[sessionId];
    await this.saveState();

    // Optional: Delete from D1 (async)
    this.deleteFromD1(sessionId).catch((error) => {
      console.error('SessionStore: D1 delete failed:', error);
    });

    return hadSession;
  }
}
```

#### Step 2: CleanupLogicUpdate

```typescript
private async cleanupExpiredSessions(): Promise<void> {
  await this.initializeState();

  const now = Date.now();
  let cleaned = 0;
  const sessions = this.sessionStoreState!.sessions;

  for (const [sessionId, session] of Object.entries(sessions)) {
    if (session.expiresAt <= now) {
      delete sessions[sessionId];
      cleaned++;
    }
  }

  if (cleaned > 0) {
    await this.saveState();
    console.log(`SessionStore: Cleaned up ${cleaned} expired sessions`);
  }

  this.sessionStoreState!.lastCleanup = now;
}
```

#### Migrationstrategy

```
Phase 1: Dual Write period（1weeks）
┌──────────────────┐
│ SessionStore DO  │
├──────────────────┤
│ 1. Write DO ✅   │
│ 2. Write D1 ⚠️   │  ← Continue as backup
│ 3. Read DO ✅    │
│    Fallback D1   │  ← migration period only
└──────────────────┘

Phase 2: DO standalone period（Permanent）
┌──────────────────┐
│ SessionStore DO  │
├──────────────────┤
│ 1. Write DO ✅   │
│ 2. Optional D1   │  ← Audit log only
│ 3. Read DO ✅    │
└──────────────────┘
```

**Effort estimation**: 2-3days
- codeChanges: 1days
- test: 1days
- Migration: 0.5-1days

---

### 2.10 AuthorizationCodeStore DO persistence + migration（Critical）⚠️ NEW

**strategy**: persistence implementation + Token endpoint migration

#### Step 1: Durable Storageimplementation（SessionStoreSimilar）

```typescript
// packages/shared/src/durable-objects/AuthorizationCodeStore.ts

interface AuthCodeStoreState {
  codes: Record<string, AuthorizationCode>;
  lastCleanup: number;
}

export class AuthorizationCodeStore {
  private state: DurableObjectState;
  private env: Env;
  private authCodeState: AuthCodeStoreState | null = null;

  private async initializeState(): Promise<void> {
    if (this.authCodeState !== null) {
      return;
    }

    const stored = await this.state.storage.get<AuthCodeStoreState>('state');

    if (stored) {
      this.authCodeState = stored;
    } else {
      this.authCodeState = {
        codes: {},
        lastCleanup: Date.now(),
      };
      await this.saveState();
    }

    this.startCleanup();
  }

  private async saveState(): Promise<void> {
    if (this.authCodeState) {
      await this.state.storage.put('state', this.authCodeState);
    }
  }

  /**
   * Store code (Durable Storage)
   */
  async storeCode(request: StoreCodeRequest): Promise<{ success: boolean; expiresAt: number }> {
    await this.initializeState();

    // DDoS protection
    const userCodeCount = this.countUserCodes(request.userId);
    if (userCodeCount >= this.MAX_CODES_PER_USER) {
      throw new Error('Too many authorization codes for this user');
    }

    const now = Date.now();
    const authCode: AuthorizationCode = {
      code: request.code,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      userId: request.userId,
      scope: request.scope,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      nonce: request.nonce,
      state: request.state,
      used: false,
      expiresAt: now + this.CODE_TTL * 1000,
      createdAt: now,
    };

    // Save to Durable Storage
    this.authCodeState!.codes[request.code] = authCode;
    await this.saveState();

    return {
      success: true,
      expiresAt: authCode.expiresAt,
    };
  }

  /**
   * Consume code (atomic with Durable Storage)
   */
  async consumeCode(request: ConsumeCodeRequest): Promise<ConsumeCodeResponse> {
    await this.initializeState();

    const stored = this.authCodeState!.codes[request.code];

    if (!stored) {
      throw new Error('invalid_grant: Authorization code not found or expired');
    }

    // Expiration check
    if (this.isExpired(stored)) {
      delete this.authCodeState!.codes[request.code];
      await this.saveState();
      throw new Error('invalid_grant: Authorization code expired');
    }

    // Replay attack detection (atomic with DO)
    if (stored.used) {
      console.warn(`SECURITY: Replay attack detected! Code ${request.code}`);
      throw new Error('invalid_grant: Authorization code already used');
    }

    // Client ID validation
    if (stored.clientId !== request.clientId) {
      throw new Error('invalid_grant: Client ID mismatch');
    }

    // PKCE validation
    if (stored.codeChallenge) {
      if (!request.codeVerifier) {
        throw new Error('invalid_grant: code_verifier required for PKCE');
      }

      const challenge = await this.generateCodeChallenge(
        request.codeVerifier,
        stored.codeChallengeMethod || 'S256'
      );

      if (challenge !== stored.codeChallenge) {
        throw new Error('invalid_grant: Invalid code_verifier');
      }
    }

    // Mark as used ATOMICALLY (Durable Storage guarantees)
    stored.used = true;
    this.authCodeState!.codes[request.code] = stored;
    await this.saveState();

    return {
      userId: stored.userId,
      scope: stored.scope,
      redirectUri: stored.redirectUri,
      nonce: stored.nonce,
      state: stored.state,
    };
  }
}
```

#### Step 2: Token Endpointmigration（最Important）

```typescript
// packages/op-token/src/token.ts

async function handleAuthorizationCodeGrant(c, formData) {
  // ... validation ...

  // OLD: KV-based (remove this)
  // const authCodeData = await getAuthCode(c.env, validCode);

  // NEW: Use AuthorizationCodeStore DO
  const codeStoreId = c.env.AUTH_CODE_STORE.idFromName(validCode);
  const codeStore = c.env.AUTH_CODE_STORE.get(codeStoreId);

  try {
    const authData = await codeStore.fetch(
      new Request(`https://auth-code-store/consume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: validCode,
          clientId: client_id,
          codeVerifier: code_verifier,
        }),
      })
    );

    if (!authData.ok) {
      const error = await authData.json();
      return c.json(error, 400);
    }

    const authCodeData = await authData.json();

    // ... rest of token generation ...
  } catch (error) {
    // Handle errors
    return c.json({ error: 'invalid_grant', error_description: error.message }, 400);
  }

  // OLD: Remove markAuthCodeAsUsed() - now handled by consumeCode()
  // await markAuthCodeAsUsed(c.env, validCode, {...});
}
```

**Effort estimation**: 2-3days
- Step 1 (persistence): 1days
- Step 2 (Token endpoint migration): 1days
- test + migration: 1days

---

### 2.11 PAR request_uri Race conditionstate対処（Medium）⚠️ NEW

#### Option 1: Durable Object for PAR（完all resolve）

```typescript
// packages/shared/src/durable-objects/PARRequestStore.ts (new)

interface PARRequest {
  requestUri: string;
  clientId: string;
  data: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

export class PARRequestStore {
  private state: DurableObjectState;
  private requests: Record<string, PARRequest> = {};

  async storeRequest(requestUri: string, data: Record<string, unknown>, ttl: number) {
    const now = Date.now();
    this.requests[requestUri] = {
      requestUri,
      clientId: data.client_id as string,
      data,
      createdAt: now,
      expiresAt: now + ttl * 1000,
      used: false,
    };

    await this.state.storage.put('requests', this.requests);
  }

  /**
   * Consume request atomically (single-use guarantee)
   */
  async consumeRequest(requestUri: string, clientId: string): Promise<Record<string, unknown> | null> {
    const request = this.requests[requestUri];

    if (!request) {
      return null;
    }

    // Expiration check
    if (request.expiresAt <= Date.now()) {
      delete this.requests[requestUri];
      await this.state.storage.put('requests', this.requests);
      return null;
    }

    // Client ID validation
    if (request.clientId !== clientId) {
      throw new Error('client_id mismatch');
    }

    // Single-use check (ATOMIC)
    if (request.used) {
      console.warn(`SECURITY: PAR request_uri reuse detected: ${requestUri}`);
      throw new Error('request_uri already used');
    }

    // Mark as used ATOMICALLY
    request.used = true;
    this.requests[requestUri] = request;
    await this.state.storage.put('requests', this.requests);

    return request.data;
  }
}
```

#### Option 2: Current受容 + Monitoring（Recommended）

**Reason**:
- 攻撃難易度極めてHigh（precise taiミnグcontrolrequired）
- Impactrangelimited（他Security層保護）
- implementationCostHigh（newDO + Migration）

**代替apロチ**:

```typescript
// packages/op-auth/src/authorize.ts

// Add monitoring for concurrent request_uri usage
const requestData = await c.env.STATE_STORE.get(`request_uri:${request_uri}`);

if (!requestData) {
  return c.json({ error: 'invalid_request', error_description: 'Invalid or expired request_uri' }, 400);
}

// Add a "processing" marker (best-effort detection)
const processingKey = `request_uri_processing:${request_uri}`;
const alreadyProcessing = await c.env.STATE_STORE.get(processingKey);

if (alreadyProcessing) {
  // Log potential concurrent usage
  console.warn(`Potential concurrent PAR request_uri usage: ${request_uri}`);
  // Optionally: create alert
}

// Mark as processing
await c.env.STATE_STORE.put(processingKey, 'true', { expirationTtl: 60 });

// ... use data ...

// Delete both keys
await c.env.STATE_STORE.delete(`request_uri:${request_uri}`);
await c.env.STATE_STORE.delete(processingKey);
```

**Recommended**: Option 2（Current受容 + Monitoring）

**Effort estimation**: 0.5-1days（Monitoringonly）

---

## 3. implementationPriority順位

### Priority 1: CriticalSecuritymodification

#### 3.1 authorizationcodeDOmigration (Estimated effort: 2-3days)

**Task**:
1. `authorize.ts` modification - AuthorizationCodeStore DOuse
2. `token.ts` modification - consumeCode() APIuse
3. `AuthorizationCodeStore.ts` Extension - PKCEVerification, 再利用Detection
4. integratetest - authorizationflowall体
5. Securitytest - 再利用攻撃シナriオ

**File changes**:
- `packages/op-auth/src/authorize.ts`
- `packages/op-token/src/token.ts`
- `packages/shared/src/durable-objects/AuthorizationCodeStore.ts`
- `test/integration/authorization-code-flow.test.ts` (new)

#### 3.2 KVcacheDisable化modification (Estimated effort: 1days)

**Task**:
1. `cloudflare-adapter.ts` modification - Delete-Then-Write
2. ErrorハnドrinグAdd
3. integratetest - clientUpdateflow

**File changes**:
- `packages/shared/src/storage/adapters/cloudflare-adapter.ts`
- `test/integration/client-cache.test.ts` (new)

---

### Priority 2: 信頼性Improvement

#### 3.3 D1writeRetryLogic (Estimated effort: 3-4days)

**Task**:
1. `SessionStore.ts` modification - Retryqueueimplementation
2. MonitoringユtiritiCreate - `monitoring.ts`
3. Alertintegrate - Cloudflare Analytics Engine
4. integratetest - Failureシナriオ
5. loadtest - queuePerformance

**File changes**:
- `packages/shared/src/durable-objects/SessionStore.ts`
- `packages/shared/src/utils/monitoring.ts` (new)
- `test/durable-objects/SessionStore.retry.test.ts` (new)

#### 3.4 RefreshTokenRotatorpersistence (Estimated effort: 2-3days)

**Task**:
1. `RefreshTokenRotator.ts` modification - Durable Storageuse
2. `initializeState()` / `saveState()` メソtドAdd
3. ExistingメソtドpersistenceSupport (create, rotate, revoke)
4. migrationtest - Existingtokenfamilymigration
5. loadtest - storageサiズ制限Confirm

**File changes**:
- `packages/shared/src/durable-objects/RefreshTokenRotator.ts`
- `test/durable-objects/RefreshTokenRotator.persistence.test.ts` (new)

#### 3.5 Passkey Counter Compare-and-Swap implementation (Estimated effort: 1-2days)

**Task**:
1. `cloudflare-adapter.ts`  `updateCounter()` modification
2. Conditional付きUPDATE文implementation
3. RetryLogicAdd
4. WebAuthnSpecificationcompliancetest
5. Parallelrequestloadtest

**File changes**:
- `packages/shared/src/storage/adapters/cloudflare-adapter.ts`
- `test/integration/passkey-counter.test.ts` (new)

---

### Priority 3: 観測性Documentation

#### 3.6 Auditlog信頼性Improvement (Estimated effort: 2-3days)

**Task**:
1. `AuditLogQueue` kuラスCreate
2. `SessionStore`  `RefreshTokenRotator` tointegrate
3. SecurityeventSync logimplementation
4. Alertintegrate
5. コnpラianスtest

**File changes**:
- `packages/shared/src/durable-objects/shared/AuditLogQueue.ts` (new)
- `packages/shared/src/durable-objects/SessionStore.ts`
- `packages/shared/src/durable-objects/RefreshTokenRotator.ts`
- `test/audit/audit-log-reliability.test.ts` (new)

#### 3.7 Rate LimitingDocumentation (Estimated effort: 0.5days)

**Task**:
1. `rate-limit.ts` DocumentationAdd（best effortprecision説明）
2. FutureImprovementOption記載
3. DO版参考implementation（コメnト）

**File changes**:
- `packages/shared/src/middleware/rate-limit.ts`

#### 3.8 sessiontokenTTLshortening (Estimated effort: 0.5days)

**Task**:
1. `session-management.ts`  TTL 調整 (300 seconds → 30 seconds)
2. DocumentationAdd（Race conditionstateImpactMinimize説明）
3. UXImpact評価

**File changes**:
- `packages/op-auth/src/session-management.ts`

#### 3.9 consistencyレベru明示化 (Estimated effort: 2days)

**Task**:
1. intaフェスExtension - `WriteOptions`
2. DocumentationCreate - consistencyモデru説明
3. clientガiド - 各操作guaranteeレベru

**File changes**:
- `packages/shared/src/storage/interfaces.ts`
- `docs/architecture/consistency-model.md` (new)

---

### Priority 4: 新発見problemSupport（v3.0）⚠️ NEW

#### 3.10 SessionStore DO persistence implementation (Estimated effort: 2-3days)

**Task**:
1. `SessionStore.ts` modification - Durable Storageuse
2. `initializeState()` / `saveState()` メソtドimplementation
3. Map → Record 変換（シriaラiゼショnSupport）
4. D1fallbackmigrationsupportimplementation
5. MigrationstrategyExecute（Dual Write period）
6. Performancetest - persistenceオバヘtド測定

**File changes**:
- `packages/shared/src/durable-objects/SessionStore.ts`
- `test/durable-objects/SessionStore.persistence.test.ts` (new)
- `test/integration/session-migration.test.ts` (new)

**Priority度**: **CRITICAL** - alluser DO on restartlogaウトed

---

#### 3.11 AuthorizationCodeStore DO persistence + Token Endpoint migration (Estimated effort: 2-3days)

**Task**:
1. `AuthorizationCodeStore.ts` modification - Durable Storageuse
2. `initializeState()` / `saveState()` メソtドimplementation
3. **Token endpoint (`token.ts`)  DO usemigration** ← 最Important
4. KV BasedFunctionDeprecation (`getAuthCode`, `markAuthCodeAsUsed`)
5. integratetest - OAuth flowall体（DO経由）
6. Securitytest - Race conditionstate解消Confirm

**File changes**:
- `packages/shared/src/durable-objects/AuthorizationCodeStore.ts`
- `packages/op-token/src/token.ts` ← **Important Changes**
- `packages/shared/src/utils/kv.ts` (Delete: `getAuthCode`, `markAuthCodeAsUsed`)
- `test/integration/authorization-code-do.test.ts` (new)

**Priority度**: **CRITICAL** - problem3（KVRace conditionstate）problem10（Lack of persistence）bothresolve

**注**: こTask 3.1（authorizationcodeDOmigration）integrate可能

---

#### 3.12 PAR request_uri Monitoringimplementation (Estimated effort: 0.5-1days)

**Task**:
1. `authorize.ts` processingマkaAdd
2. ParalleluseDetectionLogicimplementation
3. Alertintegrate - 疑わしいusePatternDetection
4. Documentation - RFC 9126 制限事項

**File changes**:
- `packages/op-auth/src/authorize.ts`
- `docs/security/par-limitations.md` (new)

**Priority度**: MEDIUM - 攻撃難易度Highく, Impactlimited

**Recommended**: Option 2（Current受容 + Monitoring）採用

---

### 総合Estimated effort（v3.0Update）

| Priority | Task | Effort | problem |
|----------|-------|------|------|
| **Priority 1** | | | |
| 3.1 | authorizationcodeDOmigration | 2-3days | #3 |
| 3.2 | KVcacheDisable化modification | 1days | #2 |
| **Priority 2** | | | |
| 3.3 | D1writeRetryLogic | 3-4days | #1 |
| 3.4 | RefreshTokenRotatorpersistence | 2-3days | #4 |
| 3.5 | Passkey Counter CASimplementation | 1-2days | #7 |
| **Priority 3** | | | |
| 3.6 | Auditlog信頼性Improvement | 2-3days | #5 |
| 3.7 | Rate LimitingDocumentation | 0.5days | #6 |
| 3.8 | sessiontokenTTLshortening | 0.5days | #8 |
| 3.9 | consistencyレベru明示化 | 2days | - |
| **Priority 4 ⚠️ NEW** | | | |
| 3.10 | SessionStore DO persistence | 2-3days | **#9** |
| 3.11 | AuthCodeStore DO persistence + Tokenmigration | 2-3days | **#10 + #3** |
| 3.12 | PAR request_uri Monitoring | 0.5-1days | **#11** |
| **Total（v2.0）** | | **14-20days** | 8problem |
| **Total（v3.0）** | | **19-27days** | **11problem** |

**v2.0 → v3.0 Increase minutes**: +5-7days（new3problemSupport）

**Recommendedimplementation順序（v3.0Update）**:

**最Priority（userImpactMaximum）**:
1. **3.10 SessionStore DO persistence（problem#9）** ← alluserDO再起動強制logaウト
2. **3.4 RefreshTokenRotator persistence（problem#4）** ← alluserRe-authenticationRequired
3. **3.11 AuthCodeStore DO persistence（problem#10）** ← OAuth flowFailure

**次点（Security）**:
4. **3.1 + 3.11integrate: authorizationcodeDOmigration（problem#3）** ← 3.11Support
5. **3.5 Passkey Counter CAS（problem#7）** ← WebAuthnSpecification違反

**そ他**:
6. 3.2 KVcache（problem#2） → 3.3 D1Retry（problem#1） → 3.6 Auditlog（problem#5）
7. 3.12 PAR Monitoring（problem#11） → 3.7-3.9 Documentation

**注**: Task3.13.11integrate可能（AuthorizationCodeStore関連for）

---

## 4. teststrategy

### 4.1 ユニtトtest

```typescript
// test/durable-objects/SessionStore.retry.test.ts

describe('SessionStore - Retry Logic', () => {
  it('should retry D1 writes on failure', async () => {
    const mockD1 = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn()
            .mockRejectedValueOnce(new Error('D1 unavailable'))
            .mockRejectedValueOnce(new Error('D1 unavailable'))
            .mockResolvedValueOnce({}),
        }),
      }),
    };

    const store = new SessionStore(state, { ...env, DB: mockD1 });
    const session = await store.createSession('user_123', 3600);

    // memoryImmediatesaveされて
    expect(store.sessions.has(session.id)).toBe(true);

    // Retryprocessing待
    await waitForQueueProcessing(store);

    // 最終的D1writeSuccess
    expect(mockD1.prepare).toHaveBeenCalledTimes(3);
  });

  it('should alert after max retries', async () => {
    const mockD1 = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockRejectedValue(new Error('D1 down')),
        }),
      }),
    };

    const alertSpy = vi.fn();
    const store = new SessionStore(state, { ...env, DB: mockD1 }, { onAlert: alertSpy });

    await store.createSession('user_123', 3600);
    await waitForQueueProcessing(store, 10000); // Maximum10 secondsWait

    // AlertsendConfirm
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'D1_WRITE_FAILURE',
        severity: 'critical',
      })
    );
  });
});
```

### 4.2 integratetest

```typescript
// test/integration/authorization-code-flow.test.ts

describe('Authorization Code Flow - Race Condition', () => {
  it('should prevent code reuse across multiple requests', async () => {
    // 1. authorizationcodefetch
    const authResponse = await app.request('/authorize', {
      method: 'GET',
      query: {
        client_id: 'test_client',
        redirect_uri: 'https://example.com/callback',
        response_type: 'code',
        scope: 'openid',
      },
    });

    const location = new URL(authResponse.headers.get('Location')!);
    const code = location.searchParams.get('code')!;

    // 2. Parallelしてtokenrequest（Race conditionstateシミュレショn）
    const [response1, response2] = await Promise.all([
      app.request('/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: 'test_client',
          client_secret: 'secret',
        }),
      }),
      app.request('/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: 'test_client',
          client_secret: 'secret',
        }),
      }),
    ]);

    // 3. Verification: 1onlySuccess, alsoう1Failure
    const results = [response1, response2].map(r => r.status);
    expect(results).toContain(200); // 1Success
    expect(results).toContain(400); // 1Failure
    expect(results.filter(s => s === 200).length).toBe(1); // Success1only
  });
});
```

### 4.3 loadtest

```typescript
// test/load/cache-invalidation.test.ts

describe('Client Cache Invalidation - Load Test', () => {
  it('should handle concurrent reads during cache invalidation', async () => {
    const clientId = 'load_test_client';

    // 100Parallelrequest
    const reads = Array.from({ length: 100 }, () =>
      app.request(`/clients/${clientId}`, { method: 'GET' })
    );

    // readMediumclientUpdate
    const update = app.request(`/clients/${clientId}`, {
      method: 'PUT',
      body: JSON.stringify({ client_name: 'Updated Name' }),
    });

    const [updateResponse, ...readResponses] = await Promise.all([update, ...reads]);

    // Verification
    expect(updateResponse.status).toBe(200);

    // allてreadSuccess（old newdata）
    for (const response of readResponses) {
      expect(response.status).toBe(200);
      const data = await response.json();
      // data一貫して（old new , どちら ）
      expect(['Old Name', 'Updated Name']).toContain(data.client_name);
    }

    // Updateafterread必ずnewdata
    const finalRead = await app.request(`/clients/${clientId}`);
    const finalData = await finalRead.json();
    expect(finalData.client_name).toBe('Updated Name');
  });
});
```

---

## 5. Migration計画

### 5.1 authorizationcodeDOmigration

**Gradualロruaウト**:

```typescript
// 環境VariableフiチャFlagcontrol
const USE_AUTH_CODE_DO = env.FEATURE_AUTH_CODE_DO === 'true';

if (USE_AUTH_CODE_DO) {
  // 新method: Durable Object
  await storeCodeInDO(env, code, data);
} else {
  // 旧method: KV
  await storeAuthCode(env, code, data);
}
```

**ロruaウトステジ**:
1. **Stage 1** (1weeks): 開発環境DOEnable化, test
2. **Stage 2** (1weeks): Canary環境5%トラフitku
3. **Stage 3** (1weeks): Canary環境50%トラフitku
4. **Stage 4** (1weeks): 本番環境100%
5. **Stage 5** (2weeksafter): KV AUTH_CODESDelete

### 5.2 Monitoring指標

```typescript
// メトrikuス収集
interface StorageMetrics {
  // D1write
  d1_write_success: number;
  d1_write_failure: number;
  d1_write_retry_count: number;
  d1_write_latency_ms: number;

  // KVcache
  kv_cache_hit_rate: number;
  kv_cache_invalidation_latency_ms: number;

  // authorizationcode
  auth_code_reuse_detected: number;
  auth_code_do_latency_ms: number;
}

// Cloudflare Workers Analytics Engine
await env.ANALYTICS.writeDataPoint({
  blobs: ['d1_write', 'success'],
  doubles: [latency],
  indexes: ['session_create'],
});
```

---

## 6. riスku軽減策

### 6.1 Retryqueuememoryuse

**riスku**: queueサiズ大きく りすぎてmemory不足

**軽減策**:
- Maximumqueueサiズ制限（example: 1000aiテム）
- oldaiテムdead letterqueueMove
- メトrikuスMonitoring: `queue_size` Alert

```typescript
private readonly MAX_QUEUE_SIZE = 1000;

async queueD1Write(operation, session): Promise<void> {
  if (this.writeQueue.size >= this.MAX_QUEUE_SIZE) {
    // dead letterqueuetoMove
    await this.moveToDeadLetterQueue(this.writeQueue.entries().next().value);
  }
  // ...
}
```

### 6.2 Durable Objectスケラビriti

**riスku**: SingleDO inスtanスボトruネtku

**軽減策**:
- Shardingstrategy: userIDBased複数DO minutes散
- Monitoring: requestレト, レiテnシ

```typescript
// Shardingexample
const shard = hashUserId(userId) % 10; // 10シャド
const doId = env.SESSION_STORE.idFromName(`shard_${shard}`);
```

### 6.3 D1write遅延累積

**riスku**: Retry多すぎて遅延増大

**軽減策**:
- バtkuオフ上限設定（Maximum30 seconds）
- D1ヘruスチェtku: 継続的障害WhenAlert + 緊急Support

---

## 7. 結論

本設計Than, 以Decreaseconsistencyguarantee実現され：

### Improvedconsistencyモデru（v3.0）

| 操作 | storage | consistencyレベru | guarantee内容 | problem |
|------|-----------|-------------|---------|------|
| **sessionCreate** | DO (persistence) + D1 (Queue) | Strong (DO) + Eventual (D1) | Durable Storagepersistence, DO再起動耐性 ✅ | #9 |
| **sessionDisable化** | DO (persistence) + D1 (Queue) | Strong | Durable StorageDelete, Immediate反映 ✅ | #9 |
| **authorizationcodesave** | DO (persistence) | Strong | ワntaiムユスguarantee, DO再起動耐性 ✅ | #10 |
| **authorizationcodeconsume** | DO (persistence) | Strong | Atomic操作, 再利用Detection, PKCEVerification ✅ | #10, #3 |
| **clientUpdate** | D1 + KV | Strong | Delete-Then-Write, 不整合windowNone ✅ | #2 |
| **tokenrotation** | DO (persistence) | Strong | Atomic, Theft detection, DO再起動耐性 ✅ | #4 |
| **Passkey Counter** | D1 (CAS) | Strong | MonotonicIncreaseguarantee, WebAuthncompliance ✅ | #7 |
| **Auditlog** | D1 (Queue + Sync) | Eventual/Strong (選択可) | Retryguarantee, ImportanteventSync ✅ | #5, #1 |
| **PAR request_uri** | KV (Monitoring) | Eventual + Detection | ParalleluseDetection, Alert ⚠️ | #11 |
| **Rate Limiting** | KV | Eventual (best effort) | Documentation, acceptable range ⚠️ | #6 |
| **sessiontoken** | KV (TTLshortening) | Eventual | ImpactMinimize（30 secondsTTL） ⚠️ | #8 |

### 発見されたproblemresolve策サマri（v3.0）

**Criticalproblem** (6件):
1. ✅ DOfromD1toAsyncwrite → Retryqueueimplementation
2. ✅ KVcacheDisable化consistencywindow → Delete-Then-Write
3. ✅ authorizationcodeKVuse → Durable Objectmigration（3.11Support）
4. ✅ RefreshTokenRotatorLack of persistence → Durable Storageimplementation
5. ⚠️ **SessionStore DOLack of persistence → Durable Storageimplementation（NEW）**
6. ⚠️ **AuthorizationCodeStore DOLack of persistence → Durable Storageimplementation + Tokenmigration（NEW）**
7. ✅ Passkey CounterRace conditionstate → Compare-and-Swap

**High MediumPriority度problem** (4件):
8. ✅ Auditlog信頼性 → Retryqueue + Sync log
9. ⚠️ Rate Limitingprecisionproblem → Documentation（許容）
10. ⚠️ sessiontokenRace conditionstate → TTLshortening（許容）
11. ⚠️ **PAR request_uri Race conditionstate → Monitoringimplementation（NEW）**

**Total**: **11issues**（v2.0: 8issues + v3.0new: 3issues）対包括的 resolve策

### Important 発見: Durable ObjectPermanent性Pattern系統的欠陥

**v3.0DetailsAudit判明ed事実**:
- 4Durable Objectsうち**3（75%）**Permanent性problem抱えて
- problem抱えるDO: RefreshTokenRotator (#4), SessionStore (#9), AuthorizationCodeStore (#10)
- correctimplementation: KeyManager only（`state.storage.put/get()` use）

**根本原因**:
- KeyManager最初正しくimplementationされた
- after続DO「in-memory + D1バtkuatp」Patternimplementationされた
- こPatternDurable Objects設計思想反

**Impact**:
- DOon restartallsession消失（problem#9） → alluser強制logaウト
- DOon restartalltokenfamily消失（problem#4） → alluserRe-authenticationRequired
- DOon restartauthorizationcode消失（problem#10） → OAuth flowFailure

**resolve策**:
- 3allDOKeyManagerPatternriファkutarinグ
- `state.storage.put/get()` よるpersistence implementation
- D1Audit log only（Option）

### 次ステtp（v3.0Update）

1. ✅ 本設計Documentationレビュ（v3.0Complete）
2. 🔧 **Priority 4（最Priority）**: DOpersistence implementation（5-7days）
   - 3.10 SessionStore DO persistence
   - 3.4 RefreshTokenRotator persistence
   - 3.11 AuthCodeStore DO persistence + Tokenmigration
3. 🔧 Priority 1: Securitymodification（3-4days）
4. 🔧 Priority 2: 信頼性Improvement（6-9days）
5. 📝 Priority 3: Documentation Monitoring（3-4days）
6. 🧪 integratetest Securitytest
7. 📊 Monitoring Alert設定
8. 🚀 Gradualロruaウト

**総Estimated effort**:
- v2.0: 14-20days
- **v3.0: 19-27days**（+5-7days）
- **約4-5weeks**

---

## 付録

### A. 参考資料

- [RFC 6749 - OAuth 2.0](https://datatracker.ietf.org/doc/html/rfc6749)
- [OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics)
- [Cloudflare Durable Objects Documentation](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare KV Consistency Model](https://developers.cloudflare.com/kv/reference/kv-consistency/)

### B. Changes履歴

| days付 | version | Changes内容 |
|------|-----------|---------|
| 2025-11-15 | 1.0 | 初版Create（Main要3issues minutes析resolve策） |
| 2025-11-15 | 2.0 | 包括的Auditよる5Addproblem発見resolve策Add:<br>- RefreshTokenRotatorLack of persistence<br>- Auditlog信頼性<br>- Rate Limitingprecisionproblem<br>- Passkey CounterRace conditionstate<br>- sessiontokenRace conditionstate<br>Total8issuestoSupport完allDocumentation |
| 2025-11-15 | 3.0 | **DetailsAuditよる3newCriticalproblem発見**:<br>- **problem#9: SessionStore DO Lack of persistence（CRITICAL）**<br>  → DO再起動alluser強制logaウト<br>- **problem#10: AuthorizationCodeStore DO Lack of persistence（CRITICAL）**<br>  → OAuth flowFailure + Token endpoint未migration<br>- **problem#11: PAR request_uri Race conditionstate（MEDIUM）**<br>  → RFC 9126Singleuseguarantee違反<br><br>**系統的Pattern発見**: 4DOうち3（75%）Permanent性problem<br>→ KeyManagerPatternto統一riファkutarinグrequired<br><br>Total**11issues**完allDocumentation, Effort19-27daysUpdate |
| 2025-11-15 | 6.0 | **allDurable Objects化to方針決定**:<br>- KV起因5issues（#6, #8, #11, #12, #21）完allresolve<br>- operation DocumentationSupport事象発生防げnotissuesDO化<br>- allstateManagementDO統一明確 aキテkuチャ原則<br>- newDO: RateLimiterCounter, SessionTokenStore, PARRequestStore, MagicLinkStore, PasskeyChallengeStore<br>- 総Effort: 20.5-28.5days（4-6weeks）<br><br>**製品方針**: OPasSecurity consistency最Priority, RFC/OIDC完allcompliance実現 |
| 2025-11-16 | 7.0 | **allDOintegrateimplementationComplete**:<br>- ✅ #6: RateLimiterCounter DOimplementation integrateComplete（100%precisionguarantee）<br>- ✅ #11: PARRequestStore DOimplementation integrateComplete（RFC 9126完allcompliance）<br>- ✅ #12: DPoPJTIStore DOimplementation integrateComplete（Replay攻撃完all防止）<br>- ✅ #13: JWKS Endpoint動的fetchimplementationComplete（KeyManager DO経由）<br>- ✅ #8, #21: ChallengeStore DOintegrateComplete（Session Token, Passkey, Magic Link）<br><br>**all8DOimplementationComplete**: SessionStore, AuthCodeStore, RefreshTokenRotator, KeyManager, ChallengeStore, RateLimiterCounter, PARRequestStore, DPoPJTIStore<br><br>**Security強化**: Atomic操作Thanrace condition完all排除, RFC/OIDC完allcompliance達成 |
| 2025-11-16 | 8.0 | **#14: スキマversionManagementimplementationComplete**:<br>- ✅ D1MigrationManagementテブruCreate（schema_migrations, migration_metadata）<br>- ✅ MigrationRunnerkuラスimplementation（チェtkuサムVerification, べき等性guarantee）<br>- ✅ CLIツruimplementation（migrate:create コマnド）<br>- ✅ DO data structure versioningimplementation（SessionStore v1）<br>- ✅ 自動Migration機能（versionDetection→migrate→save）<br>- ✅ MigrationREADMEUpdate<br><br>**all24problemMedium23problemimplementationComplete** - 残り1problemonly（#20: ConfirmproblemNone） |

---

## 6. allDurable Objects化 implementation計画（v6.0）

### 6.1 方針決定背景

#### OPas製品特性

Authrim OAuth 2.0 / OpenID Connect Provider（OP）as, 以Decrease要件満たすrequiredexist：

- **Security consistency最Priority**: 「best effort」不十 minutes
- **RFC/OIDCSpecificationto完allcompliance**: Authentication基盤as信頼性
- **攻撃耐性**: Replay攻撃, taiミnグ攻撃, Race conditionstate攻撃to完all 防御

#### operationSupportresolvecannot5issues

以Decreaseissues, Cloudflare KV**結果整合性**いう技術的制約起因for, operation Monitoring Documentation事象発生**完all防げません**：

1. **#6: Rate Limitingprecision** - ParallelrequestCount不accuratebecomepossible
2. **#8: sessiontokenRace condition** - TTLshorteningしてalsoRace conditionwindow残る
3. **#11: PAR request_uriRace condition** - Monitoring検知possibleRace condition自体防げnot
4. **#12: DPoP JTIRace condition** - Low確率技術的発生可能
5. **#21: Passkey/Magic Link チャレnジ再利用** - Parallelrequestsameチャレnジ複数回use可能

#### allDO化判断根拠

**Cost minutes析**:
- 100万ID規模also**数万円/月程度**
- SecurityinシデnトriスkuCost比較して十 minutesLowい
- Durable ObjectsrequestBilling（$0.15/million requests）

**複雑性評価**:
- newDOkuラス: 5個Add
- 総code量Increase: 約300-400行
- し し, **統一Pattern**Than保守性Improvement
- Current「KVDO混在」解消ed

**aキテkuチャ上利点**:
- all「stateManagement」DO統一 → 一貫edPattern
- KV vs DO使い minutesけ判断不要
- test容易性Improvement（DO単体test可能）

---

### 6.2 allDO化afteraキテkuチャ原則

#### storage使い minutesけ明確化

```
┌─────────────────────────────────────────────────────────┐
│              Authrim Storage Architecture                  │
│                   (Full DO Migration)                    │
└─────────────────────────────────────────────────────────┘

【Durable Objects】- 強consistency, Atomic操作, stateManagement
├─ SessionStore              (#9 - persistence implementation) ✅
├─ RefreshTokenRotator       (#4, #17 - persistence implementation) ✅
├─ AuthorizationCodeStore    (#3, #10 - persistence implementation) ✅
├─ KeyManager                (Existing - correctimplementation) ✅
├─ RateLimiterCounter        (#6 - newimplementation) ★ ✅
├─ PARRequestStore           (#11 - newimplementation) ★ ✅
├─ DPoPJTIStore              (#12 - newimplementation) ★ ✅
└─ ChallengeStore            (#8, #21 - integrateimplementation) ★ ✅
    ├─ session_token (ITP-bypass用)
    ├─ passkey_registration
    ├─ passkey_authentication
    └─ magic_link

【D1 (SQLite)】- riレショナrudata, Auditlog, persistence
├─ users
├─ clients
├─ passkeys
├─ audit_log
└─ password_reset_tokens

【KV】- read専用cacheonly
└─ CLIENTS_CACHE (client metadata cache)

【Deleteplanned】- KVfromDOto完allmigration
├─ AUTH_CODES → AuthorizationCodeStore DO ✅
├─ REFRESH_TOKENS → RefreshTokenRotator DO ✅
├─ MAGIC_LINKS → ChallengeStore DO ✅
├─ STATE_STORE (rate limit) → RateLimiterCounter DO (implementation, integratewaiting)
├─ PAR request → PARRequestStore DO (implementation, integratewaiting)
└─ DPoP JTI → DPoPJTIStore DO (implementation, integratewaiting)
```

**new原則**:
- **state持riソス** → Durable Objects
- **Singleuseriソス** → Durable Objects
- **read専用cache** → KV
- **riレショナrudata** → D1

---

### 6.3 implementationPhase

#### Phase 1: ExistingDOpersistence（CRITICAL - 5-7days）

**Purpose**: DOon restartdata損失防止

| Task | File | Effort | problem |
|--------|---------|------|------|
| SessionStore DO persistence | `SessionStore.ts` | 2-3days | #9 |
| RefreshTokenRotator DO persistence | `RefreshTokenRotator.ts` | 2-3days | #4 |
| AuthorizationCodeStore DO persistence | `AuthorizationCodeStore.ts` | 1days | #10 |

**implementation内容**:
- `state.storage.put/get()` よるpersistence
- KeyManagerPatternApply
- D1Auditlog用バtkuatponly

**Impact**:
- alluserDO再起動強制logaウトedproblemresolve
- DOon restartalltokenfamily消失防止
- OAuth flowFailure防止

---

#### Phase 2: Securitymodification（CRITICAL - 2.5-3.5days）

**Purpose**: RFCSecurity要件tocompliance

| Task | File | Effort | problem |
|--------|---------|------|------|
| Client Secret taiミnグ攻撃Countermeasure | logout.ts, token.ts, revoke.ts, introspect.ts | 0.5days | #15 |
| /revoke, /introspect AuthenticationAdd | revoke.ts, introspect.ts | 1days | #16 |
| RefreshTokenRotator usestart | token.ts | 1-2days | #17 |

**implementation内容**:
- `timingSafeEqual()` to置換
- client_secretVerificationAdd
- KVFunctionfromDOusetomigration

---

#### Phase 3: newDOimplementation（consistencyproblem完allresolve - 6-8days）★ allDO化核心

**Purpose**: KV起因Race conditionstate完all排除

##### 3.1 RateLimiterCounter DO implementation (#6) - 1-1.5days

**File**: `packages/shared/src/durable-objects/RateLimiterCounter.ts` (new)

```typescript
export class RateLimiterCounter {
  private state: DurableObjectState;
  private counts: Map<string, RateLimitRecord> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/increment' && request.method === 'POST') {
      const { clientIP, config } = await request.json();
      const result = await this.increment(clientIP, config);
      return Response.json(result);
    }

    return new Response('Not found', { status: 404 });
  }

  async increment(clientIP: string, config: RateLimitConfig): Promise<RateLimitResult> {
    const now = Math.floor(Date.now() / 1000);
    let record = this.counts.get(clientIP);

    if (!record || now >= record.resetAt) {
      // newウinドウstart
      record = {
        count: 1,
        resetAt: now + config.windowSeconds,
        firstRequestAt: now,
      };
    } else {
      // Countinkuriメnト（Atomic）
      record.count++;
    }

    this.counts.set(clientIP, record);
    await this.state.storage.put(clientIP, record); // persistence

    // Cleanup（oldエnトriDelete）
    if (this.counts.size > 10000) {
      await this.cleanup();
    }

    return {
      allowed: record.count <= config.maxRequests,
      current: record.count,
      limit: config.maxRequests,
      resetAt: record.resetAt,
      retryAfter: record.count > config.maxRequests ? record.resetAt - now : 0,
    };
  }

  private async cleanup(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const toDelete: string[] = [];

    for (const [ip, record] of this.counts.entries()) {
      if (now >= record.resetAt + 3600) { // 1When間猶予
        toDelete.push(ip);
      }
    }

    for (const ip of toDelete) {
      this.counts.delete(ip);
      await this.state.storage.delete(ip);
    }
  }
}

interface RateLimitRecord {
  count: number;
  resetAt: number;
  firstRequestAt: number;
}

interface RateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
}

interface RateLimitResult {
  allowed: boolean;
  current: number;
  limit: number;
  resetAt: number;
  retryAfter: number;
}
```

**migration元**: `packages/shared/src/middleware/rate-limit.ts`

**Benefits**:
- ✅ Rate limiting**perfect precisionguarantee**（100%）
- ✅ Parallelrequestalsoaccurate Count
- ✅ Atomic inkuriメnト

---

##### 3.2 SessionTokenStore DO implementation (#8) - 0.5-1days

**File**: `packages/shared/src/durable-objects/SessionTokenStore.ts` (new)

```typescript
export class SessionTokenStore {
  private state: DurableObjectState;
  private env: Env;
  private tokens: Map<string, SessionTokenData> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/create' && request.method === 'POST') {
      const { sessionId, ttl } = await request.json();
      const token = await this.createToken(sessionId, ttl);
      return Response.json({ token });
    }

    if (url.pathname === '/consume' && request.method === 'POST') {
      const { token } = await request.json();
      const sessionId = await this.consumeToken(token);
      return Response.json({ sessionId });
    }

    return new Response('Not found', { status: 404 });
  }

  async createToken(sessionId: string, ttl: number): Promise<string> {
    const token = `st_${crypto.randomUUID()}`;
    const data: SessionTokenData = {
      sessionId,
      used: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl * 1000,
    };

    this.tokens.set(token, data);
    await this.state.storage.put(token, data);

    return token;
  }

  async consumeToken(token: string): Promise<string | null> {
    let data = this.tokens.get(token);

    // memorynotcase, storagefromRestore
    if (!data) {
      data = await this.state.storage.get<SessionTokenData>(token);
      if (data) {
        this.tokens.set(token, data);
      }
    }

    // tokenExistしnot, use, orexpired
    if (!data || data.used || data.expiresAt <= Date.now()) {
      return null;
    }

    // AtomicuseMark（これallDO化核心）
    data.used = true;
    this.tokens.set(token, data);
    await this.state.storage.put(token, data);

    // usetokenImmediateDelete（Option）
    setTimeout(() => {
      this.tokens.delete(token);
      this.state.storage.delete(token);
    }, 1000);

    return data.sessionId;
  }
}

interface SessionTokenData {
  sessionId: string;
  used: boolean;
  createdAt: number;
  expiresAt: number;
}
```

**migration元**: `packages/op-auth/src/session-management.ts`

**Benefits**:
- ✅ sessiontoken**完all Singleuseguarantee**
- ✅ Race conditionstateNone（KVTTLshorteningresolvecan  ったproblem完allresolve）

---

##### 3.3 PARRequestStore DO implementation (#11) - 0.5-1days

**File**: `packages/shared/src/durable-objects/PARRequestStore.ts` (new)

```typescript
export class PARRequestStore {
  private state: DurableObjectState;
  private env: Env;
  private requests: Map<string, PARRequestData> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/store' && request.method === 'POST') {
      const { requestUri, data } = await request.json();
      await this.storeRequest(requestUri, data);
      return Response.json({ success: true });
    }

    if (url.pathname === '/consume' && request.method === 'POST') {
      const { requestUri } = await request.json();
      const data = await this.consumeRequest(requestUri);
      return Response.json({ data });
    }

    return new Response('Not found', { status: 404 });
  }

  async storeRequest(requestUri: string, data: PARRequestData): Promise<void> {
    data.createdAt = Date.now();
    data.expiresAt = Date.now() + 600 * 1000; // 10 minutes

    this.requests.set(requestUri, data);
    await this.state.storage.put(requestUri, data);
  }

  async consumeRequest(requestUri: string): Promise<PARRequestData | null> {
    let data = this.requests.get(requestUri);

    // memorynotcase, storagefromRestore
    if (!data) {
      data = await this.state.storage.get<PARRequestData>(requestUri);
      if (data) {
        this.requests.set(requestUri, data);
      }
    }

    // requestExistしnotorexpired
    if (!data || data.expiresAt <= Date.now()) {
      return null;
    }

    // AtomicDelete（Singleuseguarantee - RFC 9126要件）
    this.requests.delete(requestUri);
    await this.state.storage.delete(requestUri);

    return data;
  }
}

interface PARRequestData {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  createdAt?: number;
  expiresAt?: number;
}
```

**migration元**: `packages/op-auth/src/authorize.ts`

**Benefits**:
- ✅ **RFC 9126完allcompliance**（request_uriSingleuseguarantee）
- ✅ Race conditionstateNone（Monitoringresolvecan  ったproblem完allresolve）

---

##### 3.4 MagicLinkStore DO implementation (#21) - 1-1.5days

**File**: `packages/shared/src/durable-objects/MagicLinkStore.ts` (new)

```typescript
export class MagicLinkStore {
  private state: DurableObjectState;
  private env: Env;
  private links: Map<string, MagicLinkData> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/create' && request.method === 'POST') {
      const { email, ttl } = await request.json();
      const token = await this.createLink(email, ttl);
      return Response.json({ token });
    }

    if (url.pathname === '/consume' && request.method === 'POST') {
      const { token } = await request.json();
      const data = await this.consumeLink(token);
      return Response.json({ data });
    }

    return new Response('Not found', { status: 404 });
  }

  async createLink(email: string, ttl: number = 900): Promise<string> {
    const token = crypto.randomUUID();
    const data: MagicLinkData = {
      email,
      used: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl * 1000,
    };

    this.links.set(token, data);
    await this.state.storage.put(token, data);

    return token;
  }

  async consumeLink(token: string): Promise<MagicLinkData | null> {
    let data = this.links.get(token);

    // memorynotcase, storagefromRestore
    if (!data) {
      data = await this.state.storage.get<MagicLinkData>(token);
      if (data) {
        this.links.set(token, data);
      }
    }

    // rinkuExistしnot, use, orexpired
    if (!data || data.used || data.expiresAt <= Date.now()) {
      return null;
    }

    // AtomicuseMark（Replay攻撃防止）
    data.used = true;
    this.links.set(token, data);
    await this.state.storage.put(token, data);

    return data;
  }

  // 定期Cleanup（aラムExecute）
  async alarm(): Promise<void> {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [token, data] of this.links.entries()) {
      if (data.expiresAt < now - 3600000) { // expired+1When間
        toDelete.push(token);
      }
    }

    for (const token of toDelete) {
      this.links.delete(token);
      await this.state.storage.delete(token);
    }

    // NextCleanupスケジュru
    await this.state.storage.setAlarm(Date.now() + 3600000); // 1When間after
  }
}

interface MagicLinkData {
  email: string;
  used: boolean;
  createdAt: number;
  expiresAt: number;
}
```

**migration元**: `packages/op-auth/src/magic-link.ts`

**Benefits**:
- ✅ Magic Link**Replay攻撃完all防止**
- ✅ 15 minutesTTL内Parallelrequestalso確実Detection

---

##### 3.5 PasskeyChallengeStore DO implementation (#21) - 1.5-2days

**File**: `packages/shared/src/durable-objects/PasskeyChallengeStore.ts` (new)

```typescript
export class PasskeyChallengeStore {
  private state: DurableObjectState;
  private env: Env;
  private challenges: Map<string, PasskeyChallengeData> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/create' && request.method === 'POST') {
      const { userId, challenge, ttl } = await request.json();
      await this.createChallenge(userId, challenge, ttl);
      return Response.json({ success: true });
    }

    if (url.pathname === '/consume' && request.method === 'POST') {
      const { challenge } = await request.json();
      const data = await this.consumeChallenge(challenge);
      return Response.json({ data });
    }

    return new Response('Not found', { status: 404 });
  }

  async createChallenge(userId: string, challenge: string, ttl: number = 300): Promise<void> {
    const data: PasskeyChallengeData = {
      userId,
      challenge,
      used: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl * 1000,
    };

    this.challenges.set(challenge, data);
    await this.state.storage.put(challenge, data);
  }

  async consumeChallenge(challenge: string): Promise<PasskeyChallengeData | null> {
    let data = this.challenges.get(challenge);

    // memorynotcase, storagefromRestore
    if (!data) {
      data = await this.state.storage.get<PasskeyChallengeData>(challenge);
      if (data) {
        this.challenges.set(challenge, data);
      }
    }

    // チャレnジExistしnot, use, orexpired
    if (!data || data.used || data.expiresAt <= Date.now()) {
      return null;
    }

    // AtomicuseMark（Replay攻撃防止）
    data.used = true;
    this.challenges.set(challenge, data);
    await this.state.storage.put(challenge, data);

    return data;
  }

  // 定期Cleanup
  async alarm(): Promise<void> {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [challenge, data] of this.challenges.entries()) {
      if (data.expiresAt < now - 3600000) { // expired+1When間
        toDelete.push(challenge);
      }
    }

    for (const challenge of toDelete) {
      this.challenges.delete(challenge);
      await this.state.storage.delete(challenge);
    }

    // NextCleanupスケジュru
    await this.state.storage.setAlarm(Date.now() + 3600000); // 1When間after
  }
}

interface PasskeyChallengeData {
  userId: string;
  challenge: string;
  used: boolean;
  createdAt: number;
  expiresAt: number;
}
```

**migration元**: `packages/op-auth/src/passkey.ts` (6箇所)

**Benefits**:
- ✅ Passkeyチャレnジ**Replay攻撃完all防止**
- ✅ WebAuthnSpecificationto完allcompliance

---

#### Phase 4: 信頼性Improvement Cleanup（4-6days）

| Task | Effort | problem |
|--------|------|------|
| AuthCodeStore Token Endpoint migration | 1days | #3, #10 |
| D1writeRetryLogic | 3-4days | #1 |
| KVcacheDisable化modification | 1days | #2 |
| Passkey Counter CASimplementation | 1-2days | #7 |
| D1CleanupJob | 1-2days | #18 |
| OIDCcompliancemodification | 1-2days | #19, #23 |
| 部 minutesFailureCountermeasure | 1-2days | #22 |

---

#### Phase 5: test Monitoring Documentation（3-4days）

**test**:
- allOAuth/OIDCflowintegratetest
- DO再起動test
- Parallelrequesttest
- Securitytest（taiミnグ攻撃, Replay攻撃）

**Monitoring Alert**:
- DOwriteFailureAlert
- 異常PatternDetection
- CostMonitoringダtシュボド

**Documentation**:
- aキテkuチャ図Update
- consistencyモデru説明
- operationガiド

---

### 6.4 総Effort estimation

| Phase | 内容 | Effort | Priority度 |
|-------|------|------|--------|
| Phase 1 | ExistingDOpersistence | 5-7days | P0 (CRITICAL) |
| Phase 2 | Securitymodification | 2.5-3.5days | P0 (CRITICAL) |
| **Phase 3** | **newDOimplementation（allDO化）** | **6-8days** | **P1 (HIGH)** ★ |
| Phase 4 | 信頼性Improvement | 4-6days | P2 (MEDIUM) |
| Phase 5 | test Monitoring | 3-4days | P1 (HIGH) |
| **Total** | | **20.5-28.5days** | |

**Recommendedスケジュru**: 4-6weeks

---

### 6.5 implementation順序（Recommended）

#### Week 1-2: CRITICALSupport（7.5-10days）
1. SessionStore DO persistence（2-3days）
2. RefreshTokenRotator DO persistence（2-3days）
3. AuthCodeStore persistence + Tokenmigration（1-2days）
4. Client Secret taiミnグ攻撃Countermeasure (0.5days）
5. /revoke, /introspect AuthenticationAdd（1days）
6. RefreshTokenRotator usestart（1-2days）

#### Week 3: allDO化核心 ★（3-4.5days）
7. RateLimiterCounter DO（1-1.5days）
8. SessionTokenStore DO（0.5-1days）
9. PARRequestStore DO（0.5-1days）
10. integratetest（1days）

#### Week 4: allDO化完成（2.5-3.5days）
11. MagicLinkStore DO（1-1.5days）
12. PasskeyChallengeStore DO（1.5-2days）

#### Week 5-6: 信頼性 Optimization（7-10days）
13. D1RetryLogic（3-4days）
14. そ他信頼性Improvement（4-5days）
15. Securitytest Documentation（2-3days）

---

### 6.6 Migrationstrategy

#### Dual Write period

各DOmigrationGradual実施：

```
Week N:     KV only (Current)
Week N+1:   Dual Write (KV + DO) - Read from KV
Week N+2:   Dual Write (KV + DO) - Read from DO ← 切替
Week N+3:   DO only - KVDelete
```

#### フiチャFlag

各DO環境VariableフiチャFlag設定：

```toml
# wrangler.toml
[vars]
USE_RATE_LIMITER_DO = "true"
USE_SESSION_TOKEN_DO = "true"
USE_PAR_REQUEST_DO = "true"
USE_MAGIC_LINK_DO = "true"
USE_PASSKEY_CHALLENGE_DO = "true"
```

problem発生WhenImmediateKV戻せる設計. 

---

### 6.7 wrangler.toml Update

```toml
# ========================================
# new Durable Objects バinデinグ
# ========================================

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "PAR_REQUEST_STORE"
class_name = "PARRequestStore"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "DPOP_JTI_STORE"
class_name = "DPoPJTIStore"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "CHALLENGE_STORE"
class_name = "ChallengeStore"
script_name = "authrim-shared"

# ========================================
# KVDeleteplanned（Gradualmigrationafter）
# ========================================
# 以DecreaseallDO化CompleteafterDelete:
# - AUTH_CODES → AuthorizationCodeStore DO (migration)
# - REFRESH_TOKENS → RefreshTokenRotator DO (migration)
# - MAGIC_LINKS → ChallengeStore DO (migration)
# - STATE_STORE (rate limit部 minutes) → RateLimiterCounter DO (implementation, integratewaiting)
# - PAR request → PARRequestStore DO (implementation, integratewaiting)
# - DPoP JTI → DPoPJTIStore DO (implementation, integratewaiting)
```

---

### 6.8 Success指標（KPI）

#### 技術指標
- [ ] DOon restartdata損失: **0件**
- [ ] Race conditionstateよる重複発行: **0件**
- [ ] RFC/OIDCSpecification違反: **0件**
- [ ] Securitytest合格率: **100%**

#### Performance指標
- [ ] Rate limitingprecision: **100%**（Current: best effort）
- [ ] tokenSingleuseguarantee: **100%**（Current: 99.x%）
- [ ] DO応答When間: **< 50ms (p95)**

#### operation指標
- [ ] Alert設定: 5種類以上
- [ ] Monitoringダtシュボド: 完成
- [ ] DocumentationUpdate: 100%

---

### 6.9 riスkuCountermeasure

| riスku | Countermeasure | 軽減策 |
|--------|------|--------|
| DOimplementation複雑性 | 統一Pattern採用 | KeyManagerSuccessexample踏襲 |
| MigrationMedium不整合 | Dual Write period設定 | フiチャFlagロruバtku |
| Performance劣化 | loadtest実施 | DOLowレiテnシ |
| CostIncrease | CostMonitoring | 100万ID級数万円/月試算 |

---

### 6.10 DO設計Pattern（統一規約）

#### 統一intaフェス

all「Singleuseriソス」DO以DecreasePattern従う：

```typescript
export interface SingleUseResourceStore<T> {
  create(data: T, ttl: number): Promise<string>;
  consume(id: string): Promise<T | null>;
  cleanup(): Promise<void>;
}
```

#### persistencePattern（KeyManagercompliance）

```typescript
export class ExampleStore {
  private state: DurableObjectState;
  private storeState: StoreState | null = null;

  private async initializeState(): Promise<void> {
    const stored = await this.state.storage.get<StoreState>('state');
    if (stored) {
      this.storeState = stored;
    } else {
      this.storeState = { items: {}, lastCleanup: Date.now() };
    }
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('state', this.storeState);
  }

  async alarm(): Promise<void> {
    // 定期Cleanupprocessing
    await this.cleanup();
    await this.state.storage.setAlarm(Date.now() + 3600000); // 1When間after
  }
}
```

これThan, 保守性 可読性大幅Improvementし. 

---

### 6.11 allDO化Effectまめ

#### resolveedissues

| problem | Current | allDO化after |
|------|------|----------|
| #6: Rate Limitingprecision | best effort | **100% precisionguarantee** ✅ |
| #8: sessiontokenRace condition | TTLshorteningonly | **完all Singleuseguarantee** ✅ |
| #11: PAR request_uriRace condition | Monitoringonly | **RFC 9126完allcompliance** ✅ |
| #12: DPoP JTIRace condition | Low確率発生 | **Race conditionstateNone** ✅ |
| #21: Magic Link/PasskeyRace condition | Replay攻撃可能 | **Replay攻撃完all防止** ✅ |

#### aキテkuチャ上Improvement

- ✅ **統一性**: allstateManagementDOPattern統一
- ✅ **保守性**: KV vs DO使い minutesけ判断不要
- ✅ **test容易性**: DO単体test容易
- ✅ **RFC/OIDCcompliance**: Specificationto完allcompliance証明可能
- ✅ **Security**: 攻撃耐性大幅Improvement

#### Cost対Effect

**投資**:
- implementationEffort: 20.5-28.5days（4-6weeks）
- operationCost: +数万円/月（100万ID規模）

**ritan**:
- Securityinシデnトriスku: ほぼゼロ
- operationload: 大幅減（Monitoring Alert不要）
- 信頼性: OAuth/OIDC OP as完all 信頼獲得

**結論**: OPas製品価Value考える, allDO化**Required投資**

---

### 6.12 次ステtp

1. ✅ allDO化implementation計画レビュ（v6.0Complete）
2. 🔧 **Phase 1start**: SessionStore DO persistencefrom着手
3. 📊 継続的 進捗報告test実施
4. 🚀 GradualロruaウトMonitoring

