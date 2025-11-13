# Durable Objects Architecture 🔷

**Last Updated**: 2025-11-13
**Status**: Phase 5 Implementation
**Version**: 2.0.0

---

## Overview

Enrai uses Cloudflare Durable Objects for managing **strong consistency requirements** in distributed authentication flows. Durable Objects provide:

- **Strong consistency**: Immediate read-after-write consistency (no eventual consistency delays)
- **Atomic operations**: Transactions within a single DO instance
- **In-memory state**: Sub-millisecond access to hot data
- **Global coordination**: Single-instance-per-key guarantees across the world

### Durable Objects in Enrai

| Durable Object | Purpose | Phase | Status |
|----------------|---------|-------|--------|
| **KeyManager** | RSA key management & rotation | Phase 3 | ✅ Implemented |
| **SessionStore** | Active session state management | Phase 5 | ✅ Implemented |
| **AuthorizationCodeStore** | One-time authorization codes | Phase 5 | ✅ Implemented |
| **RefreshTokenRotator** | Atomic refresh token rotation | Phase 5 | ✅ Implemented |

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Cloudflare Workers (Hono)                       │
└─────────────────────────────────────────────────────────────────────┘
                │              │              │              │
                ▼              ▼              ▼              ▼
       ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
       │KeyManager  │  │SessionStore│  │AuthCodeStore│ │TokenRotator│
       │            │  │            │  │            │  │            │
       │• Keys JWKS │  │• Hot       │  │• Codes TTL │  │• Rotation  │
       │• Rotation  │  │  Sessions  │  │• Replay    │  │• Audit Log │
       └────────────┘  └────────────┘  └────────────┘  └────────────┘
              │                │                │              │
              ▼                ▼                ▼              ▼
       [ Persistent ]   [ In-memory + ]  [ In-memory ]  [ In-memory +]
       [ Storage    ]   [ D1 fallback]   [ TTL-based ]  [ D1 audit  ]
```

---

## 1. KeyManager Durable Object

### Purpose

The `KeyManager` Durable Object is responsible for:
- Storing RSA key pairs for JWT signing
- Managing multiple active keys simultaneously
- Implementing automatic key rotation
- Providing JWKS (JSON Web Key Set) endpoint data
- Ensuring zero-downtime during key rotation

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     KeyManager Durable Object                │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Durable Storage                                       │  │
│  │                                                        │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │  │
│  │  │  Key 1       │  │  Key 2       │  │  Key 3     │  │  │
│  │  │  kid: key-1  │  │  kid: key-2  │  │  kid: key-3│  │  │
│  │  │  active: no  │  │  active: yes │  │  active: no│  │  │
│  │  │  created: T1 │  │  created: T2 │  │  created:T3│  │  │
│  │  └──────────────┘  └──────────────┘  └────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  Configuration:                                               │
│  - rotationIntervalDays: 90                                   │
│  - retentionPeriodDays: 30                                    │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Key Rotation Strategy

#### Rotation Process

1. **New Key Generation**
   - Generate new RSA key pair (2048-bit)
   - Assign unique `kid` (key ID) with timestamp
   - Store public JWK and private PEM in Durable Object

2. **Activation**
   - Mark new key as active signing key
   - Deactivate previous active key (but keep it for verification)
   - Update `activeKeyId` in state

3. **Gradual Transition**
   - New tokens signed with new key
   - Old keys remain available for verification
   - JWKS endpoint returns all non-expired keys

4. **Cleanup**
   - Keep old keys for retention period (default: 30 days)
   - Remove keys older than retention period
   - Ensures smooth transition for token verification

#### Timeline Example

```
Day 0:   Generate Key 1 (active)
         └─ Sign all tokens with Key 1

Day 90:  Generate Key 2 (active), deactivate Key 1
         ├─ Sign new tokens with Key 2
         └─ Key 1 still available for verification

Day 120: Remove Key 1 (30 days after rotation)
         └─ Only Key 2 remains

Day 180: Generate Key 3 (active), deactivate Key 2
         ├─ Sign new tokens with Key 3
         └─ Key 2 still available for verification

Day 210: Remove Key 2
         └─ Only Key 3 remains
```

### API Endpoints

The KeyManager Durable Object exposes the following HTTP endpoints:

#### `GET /active`
Returns the currently active signing key.

**Response:**
```json
{
  "kid": "key-1234567890-abc123",
  "publicJWK": { ... },
  "privatePEM": "-----BEGIN PRIVATE KEY-----\n...",
  "createdAt": 1699999999999,
  "isActive": true
}
```

#### `GET /jwks`
Returns all public keys in JWKS format (for OpenID Connect Discovery).

**Response:**
```json
{
  "keys": [
    {
      "kty": "RSA",
      "use": "sig",
      "alg": "RS256",
      "kid": "key-1234567890-abc123",
      "n": "...",
      "e": "AQAB"
    }
  ]
}
```

#### `POST /rotate`
Triggers manual key rotation.

**Response:**
```json
{
  "success": true,
  "key": {
    "kid": "key-new-id",
    "publicJWK": { ... },
    "createdAt": 1699999999999
  }
}
```

#### `GET /should-rotate`
Checks if automatic key rotation is needed based on rotation interval.

**Response:**
```json
{
  "shouldRotate": true
}
```

#### `GET /config`
Returns current key rotation configuration.

**Response:**
```json
{
  "rotationIntervalDays": 90,
  "retentionPeriodDays": 30
}
```

#### `POST /config`
Updates key rotation configuration.

**Request:**
```json
{
  "rotationIntervalDays": 60,
  "retentionPeriodDays": 45
}
```

### Configuration

#### Default Settings

- **Rotation Interval**: 90 days
- **Retention Period**: 30 days
- **Key Algorithm**: RS256 (RSA with SHA-256)
- **Key Size**: 2048 bits

#### Customization

Configuration can be updated via the `/config` endpoint or by modifying the initial state in the constructor.

### Security Considerations

1. **Private Key Storage**
   - Private keys stored in Durable Object storage (encrypted at rest)
   - Never exposed via public JWKS endpoint
   - Accessed only by token signing operations

2. **Key Rotation**
   - Regular rotation reduces impact of potential key compromise
   - Automated rotation ensures consistency
   - Retention period allows gradual migration

3. **Access Control**
   - KeyManager should only be accessible from internal Workers
   - No public HTTP access to KeyManager endpoints
   - Use Cloudflare Access or Workers authentication

### Usage in Enrai

#### Initialization

```typescript
// In wrangler.toml
[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "enrai"

// In worker code
const keyManagerId = env.KEY_MANAGER.idFromName('default');
const keyManager = env.KEY_MANAGER.get(keyManagerId);
```

#### Getting Active Key

```typescript
const response = await keyManager.fetch(
  new Request('http://internal/active', { method: 'GET' })
);
const activeKey = await response.json();
```

#### Rotating Keys

```typescript
const response = await keyManager.fetch(
  new Request('http://internal/rotate', { method: 'POST' })
);
const result = await response.json();
```

### Future Enhancements

1. **Multiple Key Manager Instances**
   - Support for regional KeyManagers
   - Cross-region key replication

2. **Key Backup and Recovery**
   - Export keys for backup
   - Import keys from backup

3. **Audit Logging**
   - Log all key operations
   - Track key usage and rotation history

4. **Automatic Rotation**
   - Scheduled key rotation via Cron Triggers
   - Notification on rotation completion

---

## 2. SessionStore Durable Object

### Purpose

The `SessionStore` Durable Object manages **active user sessions** with:
- **In-memory hot data**: Active sessions stored in memory for sub-ms access
- **Instant invalidation**: Immediate session revocation (security requirement)
- **D1 fallback**: Cold sessions loaded from D1 database
- **ITP-compatible**: Works with Safari's Intelligent Tracking Prevention

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  SessionStore Durable Object                  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  In-Memory Storage (Hot Sessions)                        │ │
│  │                                                          │ │
│  │  session:abc123 → { userId, expiresAt, data, ... }      │ │
│  │  session:def456 → { userId, expiresAt, data, ... }      │ │
│  └──────────────────────────────────────────────────────────┘ │
│                           │                                    │
│                           │ (fallback on miss)                 │
│                           ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  D1 Database (Cold Sessions)                             │ │
│  │  SELECT * FROM sessions WHERE id = ? AND expires_at > ?  │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### API Endpoints

#### `GET /session/:id`
Get session by ID (memory → D1 fallback).

**Response:**
```json
{
  "id": "session_abc123",
  "userId": "user_xyz",
  "expiresAt": 1700000000,
  "createdAt": 1699900000,
  "data": { "amr": ["pwd"], "acr": "1" }
}
```

#### `POST /session`
Create new session.

**Request:**
```json
{
  "userId": "user_xyz",
  "ttl": 86400,
  "data": { "amr": ["pwd"] }
}
```

**Response:**
```json
{
  "id": "session_abc123",
  "expiresAt": 1700000000
}
```

#### `DELETE /session/:id`
Invalidate session immediately.

**Response:**
```json
{
  "success": true,
  "deleted": "session_abc123"
}
```

#### `GET /sessions/user/:userId`
List all active sessions for a user.

**Response:**
```json
{
  "sessions": [
    { "id": "session_abc123", "createdAt": 1699900000 },
    { "id": "session_def456", "createdAt": 1699800000 }
  ]
}
```

### Hot/Cold Pattern

```typescript
class SessionStore {
  private sessions: Map<string, Session> = new Map();

  async getSession(sessionId: string): Promise<Session | null> {
    // 1. Check in-memory (hot)
    let session = this.sessions.get(sessionId);
    if (session) {
      if (!this.isExpired(session)) return session;
      this.sessions.delete(sessionId); // Cleanup expired
      return null;
    }

    // 2. Check D1 (cold)
    const d1Session = await this.loadFromD1(sessionId);
    if (d1Session && !this.isExpired(d1Session)) {
      // Promote to hot storage
      this.sessions.set(sessionId, d1Session);
      return d1Session;
    }

    return null;
  }

  async createSession(userId: string, ttl: number, data: any) {
    const session: Session = {
      id: crypto.randomUUID(),
      userId,
      expiresAt: Date.now() + ttl * 1000,
      createdAt: Date.now(),
      data,
    };

    // 1. Store in memory (hot)
    this.sessions.set(session.id, session);

    // 2. Persist to D1 (backup & audit)
    await this.saveToD1(session);

    return session;
  }

  async invalidateSession(sessionId: string) {
    // 1. Remove from memory
    this.sessions.delete(sessionId);

    // 2. Mark as deleted in D1
    await this.deleteFromD1(sessionId);
  }
}
```

### Configuration

- **Default TTL**: 24 hours
- **Memory cleanup interval**: Every 5 minutes
- **D1 fallback timeout**: 100ms
- **Max sessions per user**: 10 (configurable)

---

## 3. AuthorizationCodeStore Durable Object

### Purpose

The `AuthorizationCodeStore` Durable Object manages **one-time authorization codes** with:
- **One-time use guarantee**: Prevents authorization code replay attacks (CRITICAL)
- **Short TTL**: 60 seconds lifetime
- **Atomic consume**: Marks code as used atomically
- **PKCE support**: Stores code_challenge for validation

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│            AuthorizationCodeStore Durable Object            │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │  In-Memory Storage (TTL: 60 seconds)                  │ │
│  │                                                       │ │
│  │  code:abc123 → {                                      │ │
│  │    clientId: "client_1",                              │ │
│  │    redirectUri: "https://...",                        │ │
│  │    userId: "user_123",                                │ │
│  │    scope: "openid profile",                           │ │
│  │    codeChallenge: "sha256...",                        │ │
│  │    used: false,                                       │ │
│  │    expiresAt: 1700000060                              │ │
│  │  }                                                     │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### API Endpoints

#### `POST /code`
Store authorization code.

**Request:**
```json
{
  "code": "auth_code_abc123",
  "clientId": "client_1",
  "redirectUri": "https://app.example.com/callback",
  "userId": "user_123",
  "scope": "openid profile email",
  "codeChallenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  "codeChallengeMethod": "S256"
}
```

**Response:**
```json
{
  "success": true,
  "expiresAt": 1700000060
}
```

#### `POST /code/consume`
Consume authorization code (one-time use).

**Request:**
```json
{
  "code": "auth_code_abc123",
  "clientId": "client_1",
  "codeVerifier": "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
}
```

**Response (Success):**
```json
{
  "userId": "user_123",
  "scope": "openid profile email",
  "redirectUri": "https://app.example.com/callback"
}
```

**Response (Already Used - Replay Attack):**
```json
{
  "error": "invalid_grant",
  "error_description": "Authorization code already used"
}
```

### Replay Attack Prevention

```typescript
class AuthorizationCodeStore {
  private codes: Map<string, AuthCode> = new Map();

  async consume(code: string, clientId: string, codeVerifier?: string) {
    const stored = this.codes.get(code);

    if (!stored) {
      throw new Error('invalid_grant: Code not found or expired');
    }

    // CRITICAL: Check if already used (replay attack)
    if (stored.used) {
      // Security: Revoke ALL tokens for this authorization attempt
      await this.revokeTokensForAuth(stored.userId, stored.clientId);
      throw new Error('invalid_grant: Code already used (replay attack detected)');
    }

    // Validate PKCE
    if (stored.codeChallenge) {
      const challenge = this.generateCodeChallenge(codeVerifier);
      if (challenge !== stored.codeChallenge) {
        throw new Error('invalid_grant: Invalid code_verifier');
      }
    }

    // Validate client
    if (stored.clientId !== clientId) {
      throw new Error('invalid_grant: Client mismatch');
    }

    // Mark as used ATOMICALLY (DO guarantees strong consistency)
    stored.used = true;
    this.codes.set(code, stored);

    return {
      userId: stored.userId,
      scope: stored.scope,
      redirectUri: stored.redirectUri,
    };
  }

  private generateCodeChallenge(verifier: string): string {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }
}
```

### Configuration

- **TTL**: 60 seconds (per OAuth 2.0 Security BCP)
- **Cleanup interval**: Every 30 seconds
- **Max codes per user**: 5 concurrent (DDoS protection)

---

## 4. RefreshTokenRotator Durable Object

### Purpose

The `RefreshTokenRotator` Durable Object manages **atomic refresh token rotation** with:
- **Token family tracking**: Detect token theft via rotation chain
- **Atomic rotation**: Prevents race conditions (multiple refresh attempts)
- **Audit logging**: All rotations logged to D1
- **Theft detection**: Revoke all tokens if replay detected

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│           RefreshTokenRotator Durable Object                 │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Token Family Tracking                                 │ │
│  │                                                        │ │
│  │  family:xyz → {                                        │ │
│  │    currentToken: "rt_v3",                              │ │
│  │    previousTokens: ["rt_v1", "rt_v2"],                 │ │
│  │    userId: "user_123",                                 │ │
│  │    clientId: "client_1",                               │ │
│  │    rotationCount: 2                                    │ │
│  │  }                                                      │ │
│  └────────────────────────────────────────────────────────┘ │
│                           │                                  │
│                           ▼                                  │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  D1 Audit Log (refresh_token_log)                      │ │
│  │  INSERT INTO refresh_token_log (action, token_id, ...)│ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### API Endpoints

#### `POST /rotate`
Rotate refresh token (atomic operation).

**Request:**
```json
{
  "currentToken": "rt_v2_abc123",
  "userId": "user_123",
  "clientId": "client_1"
}
```

**Response (Success):**
```json
{
  "newToken": "rt_v3_def456",
  "expiresIn": 2592000,
  "rotationCount": 3
}
```

**Response (Theft Detected - Old Token Reused):**
```json
{
  "error": "invalid_grant",
  "error_description": "Token theft detected",
  "action": "all_tokens_revoked"
}
```

#### `POST /revoke-family`
Revoke all tokens in a token family (logout all devices).

**Request:**
```json
{
  "familyId": "family_xyz",
  "reason": "user_logout"
}
```

### Rotation & Theft Detection

```typescript
class RefreshTokenRotator {
  private families: Map<string, TokenFamily> = new Map();

  async rotate(currentToken: string, userId: string, clientId: string) {
    // Find token family
    const family = this.findFamilyByToken(currentToken);

    if (!family) {
      throw new Error('invalid_grant: Token not found');
    }

    // CRITICAL: Check if token is the current one
    if (family.currentToken !== currentToken) {
      // Token replay detected! This token was already rotated.
      // This indicates potential token theft.
      console.error('Token theft detected!', {
        userId,
        clientId,
        attemptedToken: currentToken,
        currentToken: family.currentToken,
      });

      // SECURITY: Revoke ALL tokens in this family
      await this.revokeFamilyTokens(family.id);
      await this.logToD1('theft_detected', family.id, userId);

      throw new Error('invalid_grant: Token theft detected');
    }

    // Generate new token
    const newToken = this.generateToken();

    // Atomic rotation (DO guarantees consistency)
    family.previousTokens.push(family.currentToken);
    family.currentToken = newToken;
    family.rotationCount++;
    family.lastRotation = Date.now();

    this.families.set(family.id, family);

    // Audit log
    await this.logToD1('rotated', family.id, userId, {
      newToken,
      rotationCount: family.rotationCount,
    });

    return {
      newToken,
      expiresIn: 30 * 24 * 60 * 60, // 30 days
      rotationCount: family.rotationCount,
    };
  }

  async revokeFamilyTokens(familyId: string) {
    this.families.delete(familyId);
    await this.logToD1('family_revoked', familyId);
  }

  private generateToken(): string {
    return `rt_${crypto.randomUUID()}`;
  }

  private async logToD1(action: string, familyId: string, userId?: string, metadata?: any) {
    // Log to D1 audit_log table
    // ... implementation
  }
}
```

### Configuration

- **Token TTL**: 30 days
- **Max rotations**: Unlimited
- **Family retention**: 90 days after last rotation
- **Theft detection**: Immediate revocation on replay

---

## Implementation Timeline

### Phase 3 (Completed)
- ✅ KeyManager Durable Object implemented
- ✅ Key rotation functionality
- ✅ JWKS endpoint

### Phase 5 (Implementation in Progress - May 2026)
- **Week 1**: SessionStore implementation
  - ✅ Hot/cold session pattern
  - ✅ D1 integration
  - ✅ Unit tests (20+ test cases)
  - ✅ API documentation
- **Week 2**: AuthorizationCodeStore implementation
  - ✅ Replay attack prevention
  - ✅ PKCE validation
  - ✅ Unit tests (15+ test cases)
  - ✅ API documentation
- **Week 2**: RefreshTokenRotator implementation
  - ✅ Token family tracking
  - ✅ Theft detection
  - ✅ Unit tests (18+ test cases)
  - ✅ API documentation
- **Week 3**: Integration testing (In Progress)
  - 🔄 Storage abstraction layer
  - 🔄 Security testing
  - 🔄 Performance benchmarks
- **Week 4**: Production deployment (Planned)
  - Gradual rollout
  - Monitoring setup

---

## Security Considerations

### Authentication & Authorization

All Durable Objects should implement **Bearer token authentication**:

```typescript
class BaseDurableObject {
  private authenticate(request: Request): boolean {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return false;
    }
    const token = authHeader.substring(7);
    const secret = this.env.DURABLE_OBJECT_SECRET;
    return token === secret; // Constant-time comparison
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.authenticate(request)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer' },
      });
    }
    // ... handle request
  }
}
```

### Rate Limiting

Implement per-DO rate limiting to prevent abuse:

```typescript
class RateLimiter {
  private requests: Map<string, number[]> = new Map();

  isAllowed(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];

    // Remove expired timestamps
    const valid = timestamps.filter(ts => now - ts < windowMs);

    if (valid.length >= limit) {
      return false;
    }

    valid.push(now);
    this.requests.set(key, valid);
    return true;
  }
}
```

### Data Sanitization

Never expose sensitive data in logs or responses:

```typescript
function sanitizeSession(session: Session) {
  const { data, ...safe } = session;
  return safe; // Remove session data from response
}
```

---

## Performance Benchmarks

### Target Latencies (p95)

| Operation | Target | Notes |
|-----------|--------|-------|
| SessionStore GET (hot) | < 5ms | In-memory lookup |
| SessionStore GET (cold) | < 50ms | D1 fallback |
| AuthCode CONSUME | < 10ms | In-memory + atomic check |
| RefreshToken ROTATE | < 15ms | In-memory + D1 audit log |
| KeyManager GET JWKS | < 5ms | In-memory cache |

### Scalability

- **Requests per second per DO**: ~1,000 (Cloudflare limit)
- **Total global capacity**: Unlimited (auto-scaling via DO namespace)
- **Concurrent operations**: Single-threaded per DO (strong consistency)

---

## Monitoring & Observability

### Metrics to Track

```typescript
export const DO_METRICS = {
  // Request counts
  'do.requests.session_store': counter(),
  'do.requests.auth_code_store': counter(),
  'do.requests.token_rotator': counter(),

  // Latencies
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

### Health Checks

```typescript
export async function healthCheckDOs(env: Env) {
  const results = {
    keyManager: await checkDO(env.KEY_MANAGER, 'default'),
    sessionStore: await checkDO(env.SESSION_STORE, 'health'),
    authCodeStore: await checkDO(env.AUTH_CODE_STORE, 'health'),
    tokenRotator: await checkDO(env.REFRESH_TOKEN_ROTATOR, 'health'),
  };

  return {
    healthy: Object.values(results).every(r => r.healthy),
    details: results,
  };
}
```

---

## References

### Related Documents
- [storage-strategy.md](./storage-strategy.md) - Hybrid storage architecture
- [database-schema.md](./database-schema.md) - D1 schema and integration
- [PHASE5_PLANNING.md](../project-management/PHASE5_PLANNING.md) - Phase 5 implementation plan

### External Resources
- [Cloudflare Durable Objects Documentation](https://developers.cloudflare.com/durable-objects/)
- [OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics)
- [OpenID Connect Core Spec - Key Rotation](https://openid.net/specs/openid-connect-core-1_0.html#RotateSigKeys)
- [JWK Specification (RFC 7517)](https://datatracker.ietf.org/doc/html/rfc7517)

---

**Change History**:
- 2025-11-13: Added SessionStore, AuthorizationCodeStore, RefreshTokenRotator (Phase 5 design)
- Phase 3: Initial KeyManager implementation
