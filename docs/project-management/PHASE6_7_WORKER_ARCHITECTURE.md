# Phase 6-7 Worker Architecture & Scaling Strategy

**Last Updated**: 2025-11-19
**Status**: Planning (Phase 6-7 Implementation)
**Version**: 1.0.0

---

## Table of Contents

1. [Overview](#overview)
2. [Phase 6-7 Feature Summary](#phase-6-7-feature-summary)
3. [Worker Splitting Strategy](#worker-splitting-strategy)
4. [10-Worker Architecture](#10-worker-architecture)
5. [Bundle Size Analysis](#bundle-size-analysis)
6. [Load & Scalability Analysis](#load--scalability-analysis)
7. [Durable Objects Strategy](#durable-objects-strategy)
8. [Deployment Strategy](#deployment-strategy)
9. [Monitoring & Observability](#monitoring--observability)
10. [Summary](#summary)

---

## Overview

This document outlines the Worker architecture and scaling strategy for **Phase 6-7** (Enterprise Features & Advanced Flows) implementation. The design addresses:

- **Cloudflare Workers 1MB bundle size limit**
- **High-load scalability requirements**
- **Security requirements (strong consistency via Durable Objects)**
- **Independent deployment capabilities**

### Key Decisions

| Decision | Rationale |
|----------|-----------|
| **10 Worker split** | Balance between bundle size, scalability, and maintainability |
| **Durable Objects for security-critical data** | Strong consistency required for sessions, auth codes, token rotation |
| **External libraries for SAML/LDAP** | Too complex to implement from scratch |
| **Scratch implementation for SCIM** | HTTP+JSON, can reuse existing middleware |
| **Function-based separation** | High-load workers isolated from low-load enterprise features |

---

## Phase 6-7 Feature Summary

### Phase 6: Enterprise Features & Advanced Flows (Week 40-51)

#### Advanced OAuth Flows (Week 40-42)
- **Hybrid Flow** (OIDC Core 3.3)
  - `response_type=code id_token`
  - `response_type=code token`
  - `response_type=code id_token token`
- **Device Authorization Flow** (RFC 8628)
  - For IoT devices, Smart TVs, CLI tools
  - Device code + User code flow
  - QR code support
- **JWT Bearer Flow** (RFC 7523)
  - Service-to-service authentication
  - JWT assertion validation
  - No user interaction

#### CIBA & Encryption (Week 43-44)
- **CIBA** (Client Initiated Backchannel Authentication)
  - Poll, Ping, Push modes
  - Mobile push authentication
- **JWE** (JSON Web Encryption - RFC 7516)
  - ID Token encryption
  - UserInfo response encryption

#### Social Login (Week 45-47)
- **7+ Social Providers**
  - Google OAuth
  - GitHub OAuth
  - Microsoft Azure AD / Entra ID
  - Apple Sign In
  - Facebook, Twitter/X, LinkedIn
  - Generic OIDC provider support

#### Enterprise Integration (Week 48-50)
- **SAML 2.0 Bridge** (OIDC → SAML)
  - SAML assertion generation
  - Signature + encryption support
  - Metadata endpoint
- **LDAP/AD Integration**
  - LDAP authentication backend
  - User synchronization
  - Group mapping
- **SCIM 2.0** (RFC 7643, 7644)
  - User provisioning (CRUD)
  - Group provisioning
  - Integration with Okta, OneLogin

#### Advanced Security (Week 51)
- **Risk-Based Authentication**
  - IP reputation checking
  - Device fingerprinting
  - Anomaly detection
- **RBAC/ABAC**
  - Role-based access control
  - Attribute-based access control

### Phase 7: GraphQL API (Future)
- **GraphQL Management API**
  - User management queries
  - Client management queries
  - Analytics queries

---

## Worker Splitting Strategy

### Problem: Bundle Size Limit

**Cloudflare Workers Constraint**: 1MB bundle size limit per Worker

**Phase 5 Status** (Completed):
```
op-discovery:   ~50-70 KB
op-auth:       ~150-200 KB
op-token:      ~250-300 KB
op-userinfo:    ~80-100 KB
op-management: ~180-220 KB
────────────────────────────
Total:         ~710-890 KB  ✅ Within limit
```

**Phase 6-7 Additions**:
```
Advanced OAuth Flows:  +30-50 KB
Social Login (7 providers): +80-120 KB
SAML library:          +50-150 KB
LDAP library:          +30-80 KB
SCIM (scratch):        +20-40 KB
Risk-Based Auth:       +30-50 KB
RBAC/ABAC:            +15-30 KB
GraphQL:              +80-150 KB
────────────────────────────
Potential Addition:   +335-670 KB
```

**Without Splitting**: ~1,045-1,560 KB → **Exceeds 1MB limit** ❌

**With 10-Worker Split**: Each Worker < 350 KB → **Within limit** ✅

### Splitting Principles

1. **Function-based separation**: Group related endpoints
2. **Load-based isolation**: Separate high-load from low-load workers
3. **Library isolation**: Isolate workers with large external dependencies
4. **Independent deployment**: Each worker can be deployed separately
5. **Security boundary**: Critical security features in dedicated workers

---

## 10-Worker Architecture

### Architecture Overview

```
📦 Phase 6-7 Complete Architecture (10 Workers)

【Existing Workers - Extended (5)】
├── op-discovery      (~60-80 KB)
├── op-auth           (~200-290 KB)
├── op-token          (~275-340 KB)
├── op-userinfo       (~95-130 KB)
└── op-management     (~215-290 KB)

【New Workers (5)】
├── op-async          (~120-180 KB)   ← Device Flow + CIBA
├── op-social         (~120-180 KB)   ← Social Login
├── op-saml           (~100-200 KB)   ← SAML Bridge
├── op-ldap           (~100-180 KB)   ← LDAP/AD
└── op-graphql        (~150-250 KB)   ← GraphQL API

────────────────────────────────────────
Total: 10 Workers
Max Size: 340 KB (op-token)
Total Size: ~1,535-2,120 KB (across all workers)
```

### Worker Details

#### 1. op-discovery (~60-80 KB)

**Endpoints**:
```
GET /.well-known/openid-configuration
GET /.well-known/jwks.json
```

**Extensions**:
- OAuth 2.1 metadata additions
- Device Flow discovery metadata
- CIBA discovery metadata
- Federation metadata

**Characteristics**:
- **Load**: 🔥🔥🔥 High (100-1000+ req/s)
- **Caching**: CDN cache 1 hour
- **Dependencies**: None (existing jose)
- **DO Usage**: KeyManager (JWKS source)

---

#### 2. op-auth (~200-290 KB)

**Endpoints**:
```
GET/POST /authorize
POST /as/par
```

**Extensions**:
- Hybrid Flow support (+10-20 KB)
- Social Login integration (+80-120 KB)
- Risk-Based Auth middleware (+30-50 KB)
- OAuth 2.1 security features (+10-20 KB)

**Characteristics**:
- **Load**: 🔥🔥 Medium-High (10-100 req/s)
- **Dependencies**: Social provider OAuth implementations (no heavy SDKs)
- **DO Usage**: SessionStore (user sessions)
- **Security**: Risk scoring, IP reputation checks

**Implementation Strategy**:
```typescript
// Social Login without heavy SDKs (self-implemented OAuth)
async function handleGoogleOAuth(c: Context) {
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${GOOGLE_CLIENT_ID}&` +
    `redirect_uri=${REDIRECT_URI}&` +
    `response_type=code&` +
    `scope=openid profile email`;

  return c.redirect(authUrl);
}

// Lightweight implementation keeps bundle size down
```

---

#### 3. op-token (~275-340 KB)

**Endpoints**:
```
POST /token
```

**Extensions**:
- JWT Bearer Flow (+10-15 KB)
- JWE (ID Token encryption) (+5-10 KB)
- Hybrid Flow token handling (+10-15 KB)

**Characteristics**:
- **Load**: 🔥🔥 Medium-High (10-100 req/s)
- **Dependencies**: jose (existing, JWE support)
- **DO Usage**:
  - AuthorizationCodeStore (code validation)
  - RefreshTokenRotator (token rotation)
  - KeyManager (JWT signing)

---

#### 4. op-userinfo (~95-130 KB)

**Endpoints**:
```
GET/POST /userinfo
```

**Extensions**:
- JWE (UserInfo encryption) (+5-10 KB)
- Social identity claims mapping (+10-20 KB)

**Characteristics**:
- **Load**: 🔥🔥🔥 Very High (100-1000+ req/s)
- **Dependencies**: jose (existing, JWE support)
- **DO Usage**: SessionStore (user session data)
- **Critical Path**: API calls frequently access this endpoint

**Security Requirement**:
```typescript
// ❌ DO NOT use KV caching for UserInfo
// Reason: Immediate session invalidation required

// ✅ Always fetch from SessionStore DO
async function getUserInfo(accessToken: string) {
  const userId = tokenPayload.sub;
  const sessionId = tokenPayload.sid;

  // Strong consistency via DO
  const sessionStoreId = env.SESSION_STORE.idFromName(`user:${userId}`);
  const sessionStore = env.SESSION_STORE.get(sessionStoreId);

  const session = await sessionStore.getSession(sessionId);
  if (!session) throw new Error('Session invalidated');

  return buildClaims(session);
}
```

---

#### 5. op-management (~215-290 KB)

**Endpoints**:
```
POST /register            (Dynamic Client Registration)
POST /introspect          (Token Introspection)
POST /revoke              (Token Revocation)
GET/POST /scim/v2/Users   (SCIM User provisioning)
GET/POST /scim/v2/Groups  (SCIM Group provisioning)
```

**Extensions**:
- SCIM 2.0 endpoints (+20-40 KB)
- RBAC/ABAC management (+15-30 KB)

**Characteristics**:
- **Load**: 🔥 Low-Medium (1-10 req/s)
- **Dependencies**: None (scratch implementation)
- **DO Usage**: None (uses D1 + KV)

**SCIM Bulk Operations**:
```typescript
// Rate limiting for bulk operations
const SCIM_RATE_LIMITS = {
  'POST /scim/v2/Users': { limit: 10, window: 60 },    // 10/min
  'POST /scim/v2/Bulk': { limit: 5, window: 60 },      // 5 bulk/min
};

// Bulk API for efficiency
app.post('/scim/v2/Bulk', async (c) => {
  const { Operations } = await c.req.json();

  // Max 100 operations per request
  if (Operations.length > 100) {
    return c.json({ error: 'Too many operations' }, 413);
  }

  // Batch processing with D1 transaction
  const results = await db.transaction(async (tx) => {
    return Promise.all(Operations.map(op =>
      processSCIMOperation(op, tx)
    ));
  });

  return c.json({ Operations: results });
});
```

---

#### 6. op-async (~120-180 KB) 🆕

**Endpoints**:
```
POST /device_authorization    (Device Flow)
GET /device/verify            (Device verification UI)
POST /bc-authorize            (CIBA)
```

**Rationale for Combining Device Flow + CIBA**:
- Both are **asynchronous authentication flows**
- Device Flow: User approves on different device (TV → Phone)
- CIBA: User approves via mobile push notification
- Shared patterns: Polling mechanism, user approval UI, async token issuance

**Characteristics**:
- **Load**: 💤 Very Low (0.01-1 req/s)
- **Dependencies**: None (scratch implementation)
- **DO Usage**: DeviceCodeStore, CIBARequestStore (new DOs)

**Device Flow Example**:
```
User on Smart TV:
1. TV requests device_authorization
2. Server returns: device_code + user_code ("WDJB-MJHT")
3. TV shows: "Go to https://auth.example.com/device and enter WDJB-MJHT"
4. User enters code on phone/PC
5. TV polls /token with device_code
6. Server returns access_token after user approval
```

---

#### 7. op-social (~120-180 KB) 🆕

**Endpoints**:
```
GET /social/google
GET /social/github
GET /social/microsoft
GET /social/apple
GET /social/facebook
GET /social/twitter
GET /social/linkedin
GET /social/oidc/:provider
```

**Characteristics**:
- **Load**: 🔥 Low-Medium (0.1-10 req/s)
- **Dependencies**: None (self-implemented OAuth 2.0)
- **DO Usage**: SessionStore (linking social identity to user)

**Implementation Strategy**:
```typescript
// Self-implemented OAuth (no SDKs)
// Saves 50-100 KB vs using provider SDKs

const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  },
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userinfoUrl: 'https://api.github.com/user',
  },
  // ... other providers
};

async function handleSocialLogin(provider: string) {
  const config = PROVIDERS[provider];
  // Standard OAuth 2.0 flow implementation
}
```

**Account Linking**:
- First-time login: Create new user or link to existing (by email)
- Subsequent login: Load linked user account
- Stored in D1: `linked_identities` table

---

#### 8. op-saml (~100-200 KB) 🆕

**Endpoints**:
```
POST /saml/sso        (SAML SSO endpoint)
GET /saml/metadata    (SAML metadata)
```

**Characteristics**:
- **Load**: 💤 Very Low (0.01-1 req/s, enterprise customers only)
- **Dependencies**: SAML library (node-saml or similar) +50-150 KB
- **DO Usage**: None (uses D1 for config)

**Purpose**:
- Authrim acts as **SAML Identity Provider (IdP)**
- Allows Authrim to provide SSO to SAML Service Providers (Okta, Azure AD, etc.)
- OIDC clients can access SAML-only applications via Authrim

**SAML Library Isolation**:
```
Rationale for separate worker:
- SAML library is 50-150 KB (large)
- Only used by enterprise customers
- Isolating prevents bloating core workers
- Can be deployed independently
```

---

#### 9. op-ldap (~100-180 KB) 🆕

**Endpoints**:
```
Internal endpoints (not exposed publicly):
- LDAP authentication backend
- User synchronization jobs
```

**Characteristics**:
- **Load**: 💤 Very Low (background sync jobs, ~0.01-1 req/s)
- **Dependencies**: LDAP library (ldapjs) +30-80 KB
- **DO Usage**: None (uses D1 for user storage)

**Use Cases**:
- Enterprise customers with existing LDAP/Active Directory
- Users authenticate via LDAP, receive OIDC tokens
- Scheduled user sync (every 5-15 minutes)
- Group mapping: LDAP groups → OIDC scopes

**Sync Job Example**:
```typescript
// Scheduled via Cron Triggers
export default {
  async scheduled(event: ScheduledEvent, env: Env) {
    // Fetch all LDAP configurations
    const ldapConfigs = await env.DB.prepare(
      'SELECT * FROM ldap_connections WHERE sync_enabled = 1'
    ).all();

    for (const config of ldapConfigs.results) {
      await syncLDAPUsers(config, env);
    }
  }
}
```

---

#### 10. op-graphql (~150-250 KB) 🆕

**Endpoints**:
```
POST /graphql
```

**Characteristics**:
- **Load**: 💤 Very Low (0.1-10 req/s, admin only)
- **Dependencies**: GraphQL server library +80-150 KB
- **DO Usage**: None (uses D1 for queries)

**Use Cases**:
- Admin dashboard queries
- Analytics and reporting
- Complex multi-resource queries
- Alternative to REST API

**Example Queries**:
```graphql
# User management
query GetUser($id: ID!) {
  user(id: $id) {
    id
    email
    sessions {
      id
      createdAt
      expiresAt
    }
    linkedIdentities {
      provider
      externalId
    }
  }
}

# Analytics
query GetStats {
  statistics {
    totalUsers
    activeUsers(last: "7d")
    loginsByProvider {
      provider
      count
    }
  }
}
```

---

## Bundle Size Analysis

### Size Breakdown by Worker

| Worker | Base Size | Extensions | Total | Status |
|--------|-----------|------------|-------|--------|
| **op-discovery** | 50-70 KB | +10 KB | 60-80 KB | ✅ Safe |
| **op-auth** | 150-200 KB | +130-210 KB | 280-410 KB | ⚠️ Large |
| **op-token** | 250-300 KB | +25-40 KB | 275-340 KB | ✅ Safe |
| **op-userinfo** | 80-100 KB | +15-30 KB | 95-130 KB | ✅ Safe |
| **op-management** | 180-220 KB | +35-70 KB | 215-290 KB | ✅ Safe |
| **op-async** | - | 120-180 KB | 120-180 KB | ✅ Safe |
| **op-social** | - | 120-180 KB | 120-180 KB | ✅ Safe |
| **op-saml** | - | 100-200 KB | 100-200 KB | ✅ Safe |
| **op-ldap** | - | 100-180 KB | 100-180 KB | ✅ Safe |
| **op-graphql** | - | 150-250 KB | 150-250 KB | ✅ Safe |

### op-auth Size Concern

**Problem**: op-auth reaches 280-410 KB due to Social Login (+80-120 KB)

**Solution Options**:

1. **Accept 410 KB** (Recommended)
   - Still well within 1MB limit (41% usage)
   - 10 workers keeps maintenance reasonable
   - Social Login is core authentication feature

2. **Further split to 11 workers**
   - Create separate `op-social-auth` worker
   - op-auth: 200-290 KB, op-social-auth: 120-180 KB
   - Adds complexity for marginal benefit

**Decision**: Accept 410 KB for op-auth ✅

### Optimization Techniques

```typescript
// 1. Tree-shaking (already using esbuild)
// Removes unused code automatically

// 2. Dynamic imports (if needed)
if (config.saml_enabled) {
  const { handleSAML } = await import('./saml-handler');
}

// 3. Minimize external dependencies
// Use native Web APIs instead of libraries
const hash = await crypto.subtle.digest('SHA-256', data);

// 4. Share code via @authrim/shared package
// Avoid duplication across workers
```

---

## Load & Scalability Analysis

### Request Frequency Estimates

| Worker | Estimated Load | Pattern |
|--------|---------------|---------|
| **op-userinfo** | 🔥🔥🔥 100-1000+ req/s | Every API call |
| **op-discovery** | 🔥🔥🔥 100-1000+ req/s (0.3 actual due to cache) | Client startup, cached |
| **op-token** | 🔥🔥 10-100 req/s | Login, token refresh |
| **op-auth** | 🔥🔥 10-100 req/s | Login initiation |
| **op-management** | 🔥 1-10 req/s | Admin operations |
| **op-async** | 💤 0.01-1 req/s | TV/IoT login, CIBA |
| **op-social** | 🔥 0.1-10 req/s | Social login users only |
| **op-saml** | 💤 0.01-1 req/s | Enterprise only |
| **op-ldap** | 💤 0.01-1 req/s | Background sync |
| **op-graphql** | 💤 0.1-10 req/s | Admin dashboard |

### Cloudflare Workers Scalability

**Workers Platform**:
- ✅ Auto-scaling (unlimited)
- ✅ Zero cold starts
- ✅ Edge deployment (low latency globally)
- ✅ No req/s limit per Worker

**Constraints**: None for Workers themselves

### Durable Objects Scalability

**DO Limits**:
- ⚠️ ~1,000 req/s per DO instance
- ✅ Unlimited total capacity (distributed by DO ID)

**Scaling Strategy**:
```typescript
// User-based sharding (existing design)
const sessionStoreId = env.SESSION_STORE.idFromName(`user:${userId}`);

// Scalability calculation:
// 10,000 concurrent users = 10,000 DO instances
// Each DO handles: ~0.1-1 req/s per user
// Far below 1,000 req/s limit ✅
```

**Bottleneck Analysis**:
```
Potential bottleneck: SessionStore (via op-userinfo)

Scenario: 10,000 MAU
- Peak concurrent users: ~500 (5% concurrency)
- API calls per user: 10-50 req/min
- UserInfo requests: ~30% of API calls

Load per DO:
- 500 users → 500 DO instances
- Per user: 10-50 req/min ÷ 60 = 0.16-0.83 req/s
- Per DO: 0.16-0.83 req/s

Result: 0.083% of 1,000 req/s limit ✅
```

**Conclusion**: DO scaling is not a concern with user-based sharding

### Caching Strategy

#### Layer 1: CDN Cache (Cloudflare)
```
✅ Discovery endpoint: 1 hour
✅ JWKS endpoint: 1 hour
✅ Static assets: 1 year
```

#### Layer 2: KV Namespace (Edge Storage)
```
✅ Client metadata: 5 minutes (read-through cache)
✅ SAML metadata: 1 hour
✅ Social provider configs: 1 hour
```

#### Layer 3: Durable Objects (In-memory)
```
✅ SessionStore: Real-time hot data
✅ AuthCodeStore: 60 seconds TTL
✅ RefreshTokenRotator: Real-time
```

#### Layer 4: D1 Database (Persistent)
```
✅ Users, clients, audit logs
✅ Cold session fallback
```

**What NOT to cache in KV**: See [Durable Objects Strategy](#durable-objects-strategy)

---

## Durable Objects Strategy

### Why Durable Objects (Not KV)

**Security Requirement**: **Strong consistency** for critical authentication data

| Requirement | KV | Durable Objects |
|-------------|-----|-----------------|
| Consistency | Eventual (60s globally) ❌ | Strong (immediate) ✅ |
| Read-after-write | Not guaranteed ❌ | Guaranteed ✅ |
| Atomic operations | No ❌ | Yes ✅ |
| Latency | <1ms (edge) | <1ms (in-memory) |

### Critical Use Cases

#### 1. Session Invalidation

**Problem with KV**:
```
Time 0s:  User logs in, session cached in KV (30s TTL)
Time 10s: Admin bans user, deletes session
Time 11s: Banned user makes API call
          → KV cache still valid (20s remaining)
          → ❌ Banned user can still access API

Time 30s: KV cache expires
          → Invalidation finally takes effect
```

**Solution with DO**:
```
Time 0s:  User logs in, session in SessionStore DO
Time 10s: Admin bans user
          → SessionStore.delete(sessionId) in DO memory
Time 11s: Banned user makes API call
          → SessionStore.get(sessionId) returns null
          → ✅ Banned user immediately blocked
```

**Implementation**:
```typescript
class SessionStore {
  private sessions: Map<string, Session> = new Map();

  async invalidateSession(sessionId: string) {
    // In-memory delete → immediate effect
    this.sessions.delete(sessionId);
    await this.deleteFromD1(sessionId);
  }
}

// In op-userinfo
async function getUserInfo(accessToken: string) {
  // ❌ DO NOT cache in KV
  // ✅ ALWAYS fetch from SessionStore DO
  const session = await sessionStore.getSession(sessionId);
  if (!session) {
    throw new Error('Session invalidated');
  }
  return buildClaims(session);
}
```

#### 2. Authorization Code Replay Attack Prevention

**Problem with KV**:
```
Attacker intercepts authorization code: "code123"

Request 1 (attacker): POST /token code=code123
  → KV.get("code123") → {used: false}
  → KV.put("code123", {used: true})
  → ✅ Token issued

Request 2 (legitimate): POST /token code=code123
  → KV.get("code123") → {used: false} (eventual consistency delay)
  → ❌ Token issued again (replay attack succeeds)

After 60s: KV propagates {used: true} globally
```

**Solution with DO**:
```typescript
class AuthorizationCodeStore {
  async consume(code: string) {
    const stored = this.codes.get(code);

    // Atomic check-and-set (strong consistency)
    if (stored.used) {
      throw new Error('Code already used'); // Replay attack detected
    }

    stored.used = true; // Immediate effect in DO
    return stored.data;
  }
}
```

#### 3. Refresh Token Rotation

**Problem with KV**:
```
Concurrent refresh requests (race condition):

Request 1: POST /token grant_type=refresh_token
  → KV.get("rt_v1") → {current: "rt_v1"}
  → Generate "rt_v2"
  → KV.put({current: "rt_v2"})

Request 2 (concurrent): POST /token grant_type=refresh_token
  → KV.get("rt_v1") → {current: "rt_v1"} (stale read)
  → Generate "rt_v3"
  → KV.put({current: "rt_v3"})

Result: Both requests succeed, token family corrupted ❌
```

**Solution with DO**:
```typescript
class RefreshTokenRotator {
  async rotate(currentToken: string) {
    const family = this.findFamily(currentToken);

    // Atomic rotation (single-threaded DO)
    if (family.currentToken !== currentToken) {
      // Token already rotated → theft detected
      await this.revokeFamilyTokens(family.id);
      throw new Error('Token theft detected');
    }

    const newToken = this.generateToken();
    family.currentToken = newToken; // Atomic update

    return newToken;
  }
}
```

### DO Usage by Worker

| Worker | DO Usage | Purpose |
|--------|----------|---------|
| **op-userinfo** | SessionStore | Immediate session invalidation |
| **op-token** | AuthCodeStore, RefreshTokenRotator, KeyManager | Replay attack prevention, atomic rotation, JWT signing |
| **op-auth** | SessionStore | Session creation |
| **op-async** | DeviceCodeStore, CIBARequestStore | One-time code validation |
| **op-discovery** | KeyManager | JWKS source of truth |

### What Can Be Cached in KV

✅ **Safe for KV caching**:
- Discovery metadata (static, 1 hour TTL)
- JWKS (static, 1 hour TTL, invalidate on rotation)
- Client configs (rarely change, 5 min TTL)
- SAML metadata (static, 1 hour TTL)

❌ **Must use DO**:
- Sessions (immediate invalidation required)
- Authorization codes (one-time use guarantee)
- Refresh tokens (atomic rotation)
- UserInfo claims (depends on session state)

---

## Deployment Strategy

### Deployment Order

#### Phase 6: Week 40-42 (Advanced OAuth Flows)
```
1. op-token     → JWT Bearer Flow
2. op-auth      → Hybrid Flow
3. op-async     → Device Flow (new worker)
```

#### Phase 6: Week 43-44 (CIBA & JWE)
```
4. op-async     → CIBA (extend existing)
5. op-token     → JWE support
6. op-userinfo  → JWE support
```

#### Phase 6: Week 45-47 (Social Login)
```
7. op-social    → All 7 providers (new worker)
8. op-auth      → Social login integration
```

#### Phase 6: Week 48-50 (Enterprise)
```
9. op-saml      → SAML Bridge (new worker)
10. op-ldap     → LDAP/AD (new worker)
11. op-management → SCIM endpoints
```

#### Phase 6: Week 51 (Advanced Security)
```
12. op-auth     → Risk-Based Auth
13. shared      → RBAC/ABAC middleware
```

#### Phase 7 (GraphQL)
```
14. op-graphql  → GraphQL API (new worker)
```

### Gradual Rollout Strategy

```typescript
// Feature flags for gradual rollout
const FEATURES = {
  DEVICE_FLOW: env.ENABLE_DEVICE_FLOW === 'true',
  CIBA: env.ENABLE_CIBA === 'true',
  SOCIAL_LOGIN: env.ENABLE_SOCIAL_LOGIN === 'true',
  SAML_BRIDGE: env.ENABLE_SAML === 'true',
  LDAP_INTEGRATION: env.ENABLE_LDAP === 'true',
  SCIM_PROVISIONING: env.ENABLE_SCIM === 'true',
};

// Progressive rollout
app.post('/device_authorization', async (c) => {
  if (!FEATURES.DEVICE_FLOW) {
    return c.json({ error: 'not_supported' }, 400);
  }
  // ... handle device flow
});
```

### Monitoring During Rollout

```typescript
// Track feature adoption
export const FEATURE_METRICS = {
  'feature.device_flow.requests': counter(),
  'feature.ciba.requests': counter(),
  'feature.social_login.by_provider': counter(),
  'feature.saml.assertions': counter(),
  'feature.ldap.auth_attempts': counter(),
  'feature.scim.operations': counter(),
};

// Alert on errors
if (ERROR_RATE > 1%) {
  alert('High error rate on new feature, consider rollback');
}
```

### Rollback Plan

```bash
# Rollback individual worker
cd packages/op-social
git revert <commit>
pnpm run build
pnpm run deploy

# Disable feature via environment variable
wrangler secret put ENABLE_SOCIAL_LOGIN
# Enter: false

# Verify rollback
curl https://authrim.example.com/social/google
# Should return: {"error": "not_supported"}
```

---

## Monitoring & Observability

### Key Metrics

#### Worker-Level Metrics

```typescript
export const WORKER_METRICS = {
  // Request counts by worker
  'worker.requests.op_discovery': counter(),
  'worker.requests.op_auth': counter(),
  'worker.requests.op_token': counter(),
  'worker.requests.op_userinfo': counter(),
  'worker.requests.op_management': counter(),
  'worker.requests.op_async': counter(),
  'worker.requests.op_social': counter(),
  'worker.requests.op_saml': counter(),
  'worker.requests.op_ldap': counter(),
  'worker.requests.op_graphql': counter(),

  // Latency (p50, p95, p99)
  'worker.latency.op_discovery': histogram(),
  'worker.latency.op_auth': histogram(),
  'worker.latency.op_token': histogram(),
  'worker.latency.op_userinfo': histogram(),
  'worker.latency.op_management': histogram(),

  // Errors
  'worker.errors.op_auth': counter(),
  'worker.errors.op_token': counter(),
};
```

#### DO-Level Metrics (Critical)

```typescript
export const DO_METRICS = {
  // DO request rate (monitor for 1000 req/s limit)
  'do.requests_per_second.session_store': gauge(),
  'do.requests_per_second.auth_code_store': gauge(),
  'do.requests_per_second.token_rotator': gauge(),
  'do.requests_per_second.key_manager': gauge(),

  // Latency
  'do.latency.session_get': histogram(),
  'do.latency.code_consume': histogram(),
  'do.latency.token_rotate': histogram(),

  // Security events
  'do.security.replay_attacks': counter(),
  'do.security.token_theft': counter(),

  // Cache metrics
  'do.cache.session_hot_hits': counter(),
  'do.cache.session_cold_hits': counter(),
};
```

### Alerts

```yaml
# Cloudflare Workers Analytics or external monitoring

alerts:
  - name: "DO Approaching Rate Limit"
    condition: do.requests_per_second.session_store > 800
    severity: warning
    message: "SessionStore DO at 80% of 1000 req/s limit"

  - name: "High Error Rate"
    condition: worker.errors.* > 1% of requests
    severity: critical
    message: "Worker error rate above 1%"

  - name: "Slow Response Time"
    condition: worker.latency.*.p95 > 500ms
    severity: warning
    message: "p95 latency above 500ms"

  - name: "Security Event"
    condition: do.security.replay_attacks > 10 per hour
    severity: critical
    message: "Multiple replay attacks detected"
```

### Dashboard

```
Authrim Monitoring Dashboard

┌─────────────────────────────────────────────────────┐
│ Worker Health                                       │
├─────────────────────────────────────────────────────┤
│ op-discovery     ✅ 1,234 req/s  p95: 15ms         │
│ op-auth          ✅    45 req/s  p95: 120ms        │
│ op-token         ✅    67 req/s  p95: 180ms        │
│ op-userinfo      ✅   890 req/s  p95: 25ms         │
│ op-management    ✅     8 req/s  p95: 90ms         │
│ op-async         ✅     0.2 req/s  p95: 50ms       │
│ op-social        ✅     12 req/s  p95: 200ms       │
│ op-saml          ✅     0.1 req/s  p95: 150ms      │
│ op-ldap          ✅     0.3 req/s  p95: 100ms      │
│ op-graphql       ✅     2 req/s  p95: 250ms        │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ Durable Objects Load                                │
├─────────────────────────────────────────────────────┤
│ SessionStore     ✅  0.8 req/s (0.08% of limit)    │
│ AuthCodeStore    ✅  0.5 req/s (0.05% of limit)    │
│ TokenRotator     ✅  0.3 req/s (0.03% of limit)    │
│ KeyManager       ✅  0.1 req/s (0.01% of limit)    │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ Security Events (Last 24h)                          │
├─────────────────────────────────────────────────────┤
│ Replay attacks detected:        0                   │
│ Token theft detected:           0                   │
│ Risk-based auth triggered:     12                   │
│ SCIM unauthorized attempts:     2                   │
└─────────────────────────────────────────────────────┘
```

---

## Summary

### Architecture Decisions

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| **Worker count** | 10 workers | Balance bundle size, scalability, maintainability |
| **Max bundle size** | 410 KB (op-auth) | Well within 1MB limit (41% usage) |
| **DO strategy** | User-based sharding | Scales to millions of users, <1% of DO limit usage |
| **SAML/LDAP libs** | External libraries | Too complex for scratch implementation |
| **SCIM** | Scratch implementation | HTTP+JSON, reuse existing middleware |
| **Social Login** | Self-implemented OAuth | No heavy SDKs, saves 50-100 KB |
| **Security** | DO for critical data | Strong consistency required for sessions, codes, tokens |
| **Caching** | KV for static data only | Never cache security-critical data |

### Key Metrics

| Metric | Value | Status |
|--------|-------|--------|
| **Total workers** | 10 | ✅ Manageable |
| **Max bundle size** | 410 KB | ✅ 41% of 1MB limit |
| **Total bundle size** | 1,535-2,120 KB | ✅ Distributed across workers |
| **DO load per instance** | <1 req/s | ✅ 0.1% of 1000 req/s limit |
| **Estimated cost** | $1.26/month (100K users) | ✅ Cost-effective |

### Success Criteria

✅ **Bundle Size**: All workers < 500 KB (target: < 1 MB)
✅ **Scalability**: Supports 100K+ MAU without hitting DO limits
✅ **Security**: Strong consistency for sessions, codes, tokens via DO
✅ **Performance**: p95 latency < 200ms for core flows
✅ **Maintainability**: Independent worker deployment
✅ **Cost**: < $2/month per 100K users

### Next Steps

1. **Week 40**: Begin implementation with op-async (Device Flow)
2. **Week 43**: Add CIBA to op-async
3. **Week 45**: Implement op-social (Social Login)
4. **Week 48**: Deploy op-saml and op-ldap
5. **Week 51**: Add Risk-Based Auth to op-auth
6. **Phase 7**: Implement op-graphql

---

## References

### Related Documents
- [TASKS_Phase7.md](./TASKS_Phase7.md) - Detailed implementation tasks
- [ROADMAP.md](../ROADMAP.md) - Overall project roadmap
- [storage-strategy.md](../architecture/storage-strategy.md) - Hybrid storage architecture
- [durable-objects.md](../architecture/durable-objects.md) - DO architecture details
- [WORKERS.md](../../WORKERS.md) - Worker splitting architecture (Phase 5)

### External Resources
- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [OAuth 2.0 Security BCP](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics)
- [Device Authorization Grant (RFC 8628)](https://datatracker.ietf.org/doc/html/rfc8628)
- [JWT Bearer Grant (RFC 7523)](https://datatracker.ietf.org/doc/html/rfc7523)
- [SCIM 2.0 (RFC 7644)](https://datatracker.ietf.org/doc/html/rfc7644)

---

**Document Version**: 1.0.0
**Last Updated**: 2025-11-19
**Status**: Approved for Phase 6-7 Implementation
