# RefreshTokenRotator Durable Object API (V2)

## Overview

The RefreshTokenRotator Durable Object manages atomic refresh token rotation with **version-based theft detection**. V2 uses a lightweight state model that tracks rotation version numbers rather than storing actual token strings.

**V2 Architecture Benefits:**
- Minimal storage footprint (single `TokenFamilyV2` per user)
- O(1) rotation operations via in-memory Maps
- Version comparison for theft detection (simpler than token string comparison)
- Consistent response format across create and rotate operations

**Security Features:**
- Version-based theft detection (`rtv` claim in JWT)
- JTI (JWT ID) mismatch detection
- Scope amplification prevention
- Tenant boundary enforcement
- Atomic rotation (DO guarantees single-threaded execution)
- Critical event synchronous audit logging

**OAuth 2.0 Security Best Current Practice (BCP) Compliance:**
- Token Rotation: Refresh tokens rotated on every use
- Theft Detection: Old version reuse triggers family revocation
- Audit Trail: Critical events logged synchronously, routine events batched

**References:**
- OAuth 2.0 Security BCP: Draft 16, Section 4.13.2
- RFC 6749: Section 10.4 (Refresh Token Protection)

---

## V2 Data Model

### TokenFamilyV2

```typescript
interface TokenFamilyV2 {
  version: number;        // Rotation version (monotonically increasing, starts at 1)
  last_jti: string;       // Last issued JWT ID
  last_used_at: number;   // Timestamp of last use (ms)
  expires_at: number;     // Absolute expiration (ms)
  user_id: string;        // For tenant boundary enforcement
  client_id: string;      // For scope validation
  allowed_scope: string;  // Prevent scope amplification
}
```

### JWT Claims (rtv)

V2 introduces the `rtv` (Refresh Token Version) claim in refresh token JWTs:

```json
{
  "iss": "https://auth.example.com",
  "sub": "user_123",
  "aud": "client_1",
  "exp": 1702153200,
  "iat": 1699561200,
  "jti": "rt_550e8400-e29b-41d4-a716-446655440000",
  "scope": "openid profile offline_access",
  "client_id": "client_1",
  "rtv": 1
}
```

---

## Sharding Strategy

RefreshTokenRotator is **sharded by `client_id`** for horizontal scaling:

```
DO Instance: "rotator:client_1"
├── Family: user_123 → TokenFamilyV2
├── Family: user_456 → TokenFamilyV2
└── Family: user_789 → TokenFamilyV2

DO Instance: "rotator:client_2"
├── Family: user_123 → TokenFamilyV2
└── Family: user_456 → TokenFamilyV2
```

Each user can have one active refresh token family per client.

---

## Endpoints

### 1. Create Token Family

Create a new token family when issuing the first refresh token.

**Endpoint:** `POST /family`

**Request Body:**
```json
{
  "jti": "rt_550e8400-e29b-41d4-a716-446655440000",
  "userId": "user_123",
  "clientId": "client_1",
  "scope": "openid profile offline_access",
  "ttl": 2592000
}
```

**Request Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `jti` | string | Yes | JWT ID for the initial refresh token |
| `userId` | string | Yes | User ID (becomes family key) |
| `clientId` | string | Yes | OAuth client ID |
| `scope` | string | Yes | Allowed scopes (prevents amplification) |
| `ttl` | number | No | Time to live in seconds (default: 30 days) |

**Response (201 Created):**
```json
{
  "version": 1,
  "newJti": "rt_550e8400-e29b-41d4-a716-446655440000",
  "expiresIn": 2592000,
  "allowedScope": "openid profile offline_access"
}
```

---

### 2. Rotate Refresh Token

Rotate a refresh token with version-based validation.

**CRITICAL:** This operation validates both version AND JTI. Mismatch triggers family revocation.

**Endpoint:** `POST /rotate`

**Request Body:**
```json
{
  "incomingVersion": 1,
  "incomingJti": "rt_550e8400-e29b-41d4-a716-446655440000",
  "userId": "user_123",
  "clientId": "client_1",
  "requestedScope": "openid profile"
}
```

**Request Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `incomingVersion` | number | Yes | Version from JWT's `rtv` claim |
| `incomingJti` | string | Yes | JTI from incoming JWT |
| `userId` | string | Yes | User ID (from JWT's `sub` claim) |
| `clientId` | string | Yes | Client ID (from JWT's `client_id` claim) |
| `requestedScope` | string | No | Requested scope (must be subset of allowed) |

**Response (200 OK - Success):**
```json
{
  "newVersion": 2,
  "newJti": "rt_new_token_xyz789",
  "expiresIn": 2591940,
  "allowedScope": "openid profile"
}
```

**Response (400 Bad Request - Theft Detected):**
```json
{
  "error": "invalid_grant",
  "error_description": "Token theft detected. Family revoked.",
  "action": "family_revoked"
}
```

**Response (400 Bad Request - Scope Amplification):**
```json
{
  "error": "invalid_grant",
  "error_description": "invalid_scope: Scope 'admin' not allowed"
}
```

---

### 3. Revoke Token Family

Revoke all tokens in a token family.

**Endpoint:** `POST /revoke-family`

**Request Body:**
```json
{
  "userId": "user_123",
  "reason": "user_logout"
}
```

**Response (200 OK):**
```json
{
  "success": true
}
```

---

### 4. Validate Token

Validate token without rotation (for introspection).

**Endpoint:** `GET /validate?userId={userId}&version={version}&clientId={clientId}`

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `userId` | string | Yes | User ID |
| `version` | number | Yes | Token version |
| `clientId` | string | Yes | Client ID |

**Response (200 OK):**
```json
{
  "valid": true,
  "version": 3,
  "allowedScope": "openid profile",
  "expiresAt": 1702153200000
}
```

---

### 5. Get Family Information

Get information about a token family (admin/debugging).

**Endpoint:** `GET /family/:userId`

**Response (200 OK):**
```json
{
  "version": 3,
  "lastUsedAt": 1699564800000,
  "expiresAt": 1702153200000,
  "userId": "user_123",
  "clientId": "client_1",
  "allowedScope": "openid profile offline_access"
}
```

---

### 6. Health Check / Status

**Endpoint:** `GET /status`

**Response (200 OK):**
```json
{
  "status": "ok",
  "version": "v2",
  "families": {
    "total": 1250,
    "active": 1100
  },
  "timestamp": 1699561200000
}
```

---

## Security Features

### 1. Version-Based Theft Detection

```
Scenario: Token Theft Attack
─────────────────────────────
1. User authenticates → receives RT with rtv=1
2. User refreshes → rtv=1 → rtv=2 (legitimate)
3. Attacker steals old RT (rtv=1)
4. User refreshes → rtv=2 → rtv=3 (legitimate)
5. Attacker tries rtv=1 → THEFT DETECTED!
   └── incomingVersion (1) < currentVersion (3)
   └── Family revoked, attacker blocked
   └── User's rtv=3 also invalidated (must re-auth)
```

### 2. JTI Mismatch Detection

Even if an attacker guesses the correct version, JTI mismatch will trigger revocation:

```
Scenario: JTI Forgery Attack
─────────────────────────────
1. Attacker observes version = 3
2. Attacker creates fake JWT with rtv=3, random JTI
3. System checks: incomingJti ≠ family.last_jti
4. THEFT DETECTED → Family revoked
```

### 3. Scope Amplification Prevention

```typescript
// In rotate():
if (requestedScope) {
  const allowedScopes = new Set(family.allowed_scope.split(' '));
  const requestedScopes = requestedScope.split(' ');
  for (const scope of requestedScopes) {
    if (!allowedScopes.has(scope)) {
      throw new Error(`invalid_scope: Scope '${scope}' not allowed`);
    }
  }
}
```

### 4. Tenant Boundary Enforcement

Family lookup is keyed by `userId`, ensuring:
- User A cannot access User B's family
- Even with a valid version, wrong userId = "not found"

### 5. Audit Logging Strategy

| Event | Logging | Rationale |
|-------|---------|-----------|
| `created` | Async (batched) | Routine operation |
| `rotated` | Async (batched) | Routine operation |
| `theft_detected` | **Sync** | Security critical |
| `family_revoked` | **Sync** | Security critical |
| `expired` | Async (batched) | Routine cleanup |

---

## Integration with op-token

### Initial Token Issuance

```typescript
// op-token/token.ts
const rotatorId = env.REFRESH_TOKEN_ROTATOR.idFromName(`rotator:${clientId}`);
const rotator = env.REFRESH_TOKEN_ROTATOR.get(rotatorId);

const createResponse = await rotator.fetch(
  new Request('https://internal/family', {
    method: 'POST',
    body: JSON.stringify({
      jti,
      userId: sub,
      clientId,
      scope: grantedScope,
      ttl: refreshTokenExpiresIn,
    }),
  })
);

const { version, newJti, expiresIn, allowedScope } = await createResponse.json();

// Create JWT with rtv claim
const refreshToken = await createRefreshToken(
  { iss, sub, aud, scope, client_id },
  privateKey,
  kid,
  expiresIn,
  newJti,  // JTI from DO
  version  // rtv claim
);
```

### Token Rotation

```typescript
// Parse incoming refresh token
const claims = parseToken(refreshToken);
const rtv = claims.rtv as number;
const jti = claims.jti as string;

const rotateResponse = await rotator.fetch(
  new Request('https://internal/rotate', {
    method: 'POST',
    body: JSON.stringify({
      incomingVersion: rtv,
      incomingJti: jti,
      userId: claims.sub,
      clientId: claims.client_id,
      requestedScope: requestedScope,
    }),
  })
);

if (!rotateResponse.ok) {
  const error = await rotateResponse.json();
  // Handle theft detection, expired, etc.
}

const { newVersion, newJti, expiresIn, allowedScope } = await rotateResponse.json();
```

---

## Migration from V1

V2 is a complete rewrite with different API contracts:

| V1 | V2 | Change |
|----|----|----|
| `token` (string) | `jti` (string) | Token stored externally |
| `familyId` (generated) | `userId` (family key) | Simpler keying |
| `currentToken` | `incomingVersion` + `incomingJti` | Version-based validation |
| `newToken` | `newJti` + `newVersion` | JWT created by caller |
| `rotationCount` | `version` | Same concept, different name |
| Token string comparison | Version number comparison | More efficient |

---

## Performance Characteristics

| Operation | Complexity | Latency |
|-----------|------------|---------|
| Create Family | O(1) | ~5ms |
| Rotate Token | O(1) | ~5ms |
| Revoke Family | O(1) | ~5ms |
| Validate | O(1) | ~2ms |

**Memory Usage:**
- ~200 bytes per TokenFamilyV2
- In-memory Map for O(1) lookups
- Periodic cleanup of expired families

---

## Best Practices

1. **Always include `rtv` in refresh tokens** - Essential for V2 theft detection
2. **Validate both version AND JTI** - Double verification prevents forgery
3. **Monitor `theft_detected` events** - Alert on security incidents
4. **Handle revocation gracefully** - Redirect to login on family revocation
5. **Use appropriate TTL** - Balance security (shorter) vs UX (longer)
6. **Audit log analysis** - Regular review of security events
