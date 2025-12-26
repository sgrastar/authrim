# A-6: Logout/Session Management Design Document

> **Phase A-6**: Implementation design for RP-Initiated, Frontchannel, and Backchannel Logout

## 1. Overview

### 1.1 Purpose

Support three types of OIDC logout methods to enable session management and logout synchronization in SSO.

### 1.2 Target Specifications

| Specification       | RFC/Spec                                                                                       | Status                              |
| ------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------- |
| RP-Initiated Logout | [OIDC RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)   | ✅ Implemented                      |
| Frontchannel Logout | [OIDC Front-Channel Logout 1.0](https://openid.net/specs/openid-connect-frontchannel-1_0.html) | 🔲 Not implemented                  |
| Backchannel Logout  | [OIDC Back-Channel Logout 1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html)   | 🔲 Partially implemented (receive only) |
| Session Management  | [OIDC Session Management 1.0](https://openid.net/specs/openid-connect-session-1_0.html)        | 🔲 Not implemented                  |

### 1.3 Decision Summary

| Item                                  | Decision                              |
| ------------------------------------- | ------------------------------------- |
| Add Frontchannel fields simultaneously | ✅ Yes                                |
| Logout Token `exp` expiration         | 120 seconds (configurable via AdminAPI) |
| Include both `sub` and `sid`          | ✅ Yes (configurable via AdminAPI)    |
| Delivery mechanism                    | Hybrid (waitUntil + Queue)            |
| Retry count                           | 3 times (configurable via AdminAPI)   |
| Final failure handling                | Selectable, default is log only       |

### 1.4 Design Review Results

> **Evaluation: A (Very high completion level, ready for implementation)**

| Aspect              | Rating |
| ------------------- | ------ |
| OIDC Compliance     | ★★★★★  |
| Production Readiness | ★★★★★  |
| Cloudflare Fit      | ★★★★★  |
| Future Extensibility | ★★★★☆  |
| Implementation Risk | Low    |

**Differentiation Point**:

> The combination of `waitUntil + Queue + session_clients` is Authrim's differentiation point

---

## 2. Architecture

### 2.1 Overall Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Logout Flow Overview                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   ┌──────────┐         ┌───────────────┐         ┌──────────┐          │
│   │   User   │         │    Authrim    │         │    RPs   │          │
│   │(Browser) │         │     (OP)      │         │ (Clients)│          │
│   └────┬─────┘         └───────┬───────┘         └────┬─────┘          │
│        │                       │                      │                 │
│   1. Logout Request            │                      │                 │
│        │─────────────────────→ │                      │                 │
│        │   GET /logout         │                      │                 │
│        │   ?id_token_hint=...  │                      │                 │
│        │                       │                      │                 │
│   2. Session Invalidation      │                      │                 │
│        │                       │──────────────────────│                 │
│        │                       │  Delete from         │                 │
│        │                       │  SessionStore DO     │                 │
│        │                       │                      │                 │
│   3. Backchannel Logout        │                      │                 │
│        │                       │─────────────────────→│                 │
│        │                       │  POST logout_token   │                 │
│        │                       │  (via waitUntil)     │                 │
│        │                       │                      │                 │
│   4. Frontchannel Logout       │                      │                 │
│        │←──────────────────────│                      │                 │
│        │  HTML with iframes    │                      │                 │
│        │  for each RP          │───────(iframe)──────→│                 │
│        │                       │                      │                 │
│   5. Redirect                  │                      │                 │
│        │←──────────────────────│                      │                 │
│        │  302 to post_logout   │                      │                 │
│        │  _redirect_uri        │                      │                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Structure

```
packages/
├── ar-auth/
│   └── src/
│       ├── logout.ts              # Existing: RP-Initiated Logout (receive)
│       └── logout-sender.ts       # New: Backchannel/Frontchannel send
├── ar-lib-core/
│   └── src/
│       ├── services/
│       │   └── backchannel-logout-sender.ts  # New: Logout Token generation & send
│       ├── repositories/
│       │   └── core/
│       │       ├── client.ts      # Modified: Add logout URI fields
│       │       └── session-client.ts  # New: Session-Client association
│       └── types/
│           └── logout.ts          # New: Logout-related type definitions
└── ar-management/
    └── src/
        └── routes/settings/
            └── logout-config.ts   # New: Logout settings API
```

---

## 3. Database Design

### 3.1 Client Table Extension

```sql
-- Migration: add_logout_fields_to_clients
ALTER TABLE oauth_clients ADD COLUMN backchannel_logout_uri TEXT;
ALTER TABLE oauth_clients ADD COLUMN backchannel_logout_session_required INTEGER DEFAULT 0;
ALTER TABLE oauth_clients ADD COLUMN frontchannel_logout_uri TEXT;
ALTER TABLE oauth_clients ADD COLUMN frontchannel_logout_session_required INTEGER DEFAULT 0;
```

### 3.2 Session-Client Association Table (New)

```sql
-- Migration: create_session_clients_table
--
-- Purpose: Track clients that have issued tokens for a user session
-- Usage: Identify RPs to notify during Backchannel Logout
--
-- Design Review: This is the most valuable part of this design.
-- Required internally by Auth0 / Keycloak, and aligns with Authrim's design philosophy (DO separation).
--
CREATE TABLE session_clients (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  -- Token issuance time (first token issued)
  first_token_at INTEGER NOT NULL,
  -- Last token issuance time (updated on refresh)
  last_token_at INTEGER NOT NULL,
  -- Last RP liveness check time (usable for auto-skipping Dead RPs)
  -- Future extension: Update on Token refresh / UserInfo call
  last_seen_at INTEGER,

  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,

  -- Same session-client combination is unique
  UNIQUE (session_id, client_id)
);

-- Indexes
CREATE INDEX idx_session_clients_session_id ON session_clients(session_id);
CREATE INDEX idx_session_clients_client_id ON session_clients(client_id);
CREATE INDEX idx_session_clients_last_seen_at ON session_clients(last_seen_at);
```

### 3.3 Logout Token JTI Cache (Using Existing KV)

```typescript
// KV key format: bcl_jti:{jti}
// TTL: logout_token_exp_seconds + 60 (buffer)
// Purpose: Prevent Logout Token resend (duplicate check for retries)
```

### 3.4 Logout Send Pending Cache (Prevent Multiple Enqueue)

```typescript
// KV key format: logout:pending:{sessionId}:{clientId}
// TTL: 300 seconds (5 minutes)
// Purpose: Prevent multiple enqueues when multiple logouts occur in short time
//
// Design Review [REQUIRED]: Added for preventing duplicate enqueue for same client + session
```

---

## 4. Configuration Design

### 4.1 KV Configuration Keys

```typescript
// Stored in SETTINGS KV
interface LogoutSettings {
  logout: {
    // Backchannel Logout settings
    backchannel: {
      enabled: boolean; // default: true
      logout_token_exp_seconds: number; // default: 120 (spec recommends 2 min)
      include_sub_claim: boolean; // default: true
      include_sid_claim: boolean; // default: true
      request_timeout_ms: number; // default: 5000
      retry: {
        max_attempts: number; // default: 3
        initial_delay_ms: number; // default: 1000
        max_delay_ms: number; // default: 30000
        backoff_multiplier: number; // default: 2
      };
      on_final_failure: 'log_only' | 'alert'; // default: 'log_only'
    };
    // Frontchannel Logout settings
    frontchannel: {
      enabled: boolean; // default: true
      iframe_timeout_ms: number; // default: 3000
      max_concurrent_iframes: number; // default: 10
    };
    // Session Management settings
    session_management: {
      enabled: boolean; // default: true
      check_session_iframe_enabled: boolean; // default: true (for conformance)
    };
  };
}
```

### 4.2 Environment Variable Fallback

```bash
# Environment variables (fallback when KV is unavailable)
LOGOUT_BACKCHANNEL_ENABLED=true
LOGOUT_TOKEN_EXP_SECONDS=120
LOGOUT_INCLUDE_SUB_CLAIM=true
LOGOUT_INCLUDE_SID_CLAIM=true
LOGOUT_REQUEST_TIMEOUT_MS=5000
LOGOUT_RETRY_MAX_ATTEMPTS=3
LOGOUT_RETRY_INITIAL_DELAY_MS=1000
LOGOUT_RETRY_MAX_DELAY_MS=30000
LOGOUT_RETRY_BACKOFF_MULTIPLIER=2
LOGOUT_ON_FINAL_FAILURE=log_only
LOGOUT_FRONTCHANNEL_ENABLED=true
LOGOUT_IFRAME_TIMEOUT_MS=3000
```

### 4.3 Configuration Value Load Priority

```
1. Cache (in-memory, valid within request)
2. KV (SETTINGS KV)
3. Environment variables
4. Code default values (security-oriented)
```

---

## 5. Logout Token Specification

### 5.1 Claims Structure

```typescript
interface LogoutTokenClaims {
  // Required claims
  iss: string; // Issuer URL
  aud: string; // Client ID (issued to single RP)
  iat: number; // Issued at (Unix timestamp)
  exp: number; // Expiration (iat + exp_seconds)
  jti: string; // Unique token ID (UUID v4)
  events: {
    'http://schemas.openid.net/event/backchannel-logout': {};
  };

  // Conditionally required (based on settings)
  sub?: string; // Subject (user ID)
  sid?: string; // Session ID
}

// Note: nonce MUST NOT be included (spec requirement)
```

> **Design Review [REQUIRED]**: `aud` is always set to a **single client_id**.
>
> - Backchannel Logout Token is principally for a "single RP"
> - Using `string[]` causes bugs due to RP implementation differences

### 5.2 Signing

```typescript
// Uses the same signing key as ID Token
// Algorithm: RS256 (not configurable)
// 'none' algorithm is prohibited
//
// Design Review: Reusable for future FAPI support
```

### 5.3 Sample Token

```json
{
  "iss": "https://auth.example.com",
  "sub": "user_12345",
  "aud": "client_abc",
  "iat": 1703318400,
  "exp": 1703318520,
  "jti": "550e8400-e29b-41d4-a716-446655440000",
  "sid": "sid_xyz789",
  "events": {
    "http://schemas.openid.net/event/backchannel-logout": {}
  }
}
```

---

## 6. Delivery Mechanism

### 6.1 Hybrid Approach

```typescript
// logout.ts - Main flow
async function frontChannelLogoutHandler(c: Context<{ Bindings: Env }>) {
  // 1. Delete session (synchronous)
  await deleteSession(sessionId);

  // 2. Send Backchannel Logout (asynchronous, waitUntil)
  c.executionCtx.waitUntil(
    sendBackchannelLogouts(env, userId, sessionId, {
      onRetryNeeded: async (clientId, attempt) => {
        // [REQUIRED] Check for preventing duplicate enqueue
        const pendingKey = `logout:pending:${sessionId}:${clientId}`;
        const existing = await env.SETTINGS.get(pendingKey);
        if (existing) {
          console.log(`Logout already pending for ${clientId}, skipping enqueue`);
          return;
        }

        // Set pending flag (TTL: 5 min)
        await env.SETTINGS.put(pendingKey, JSON.stringify({ attempt, enqueuedAt: Date.now() }), {
          expirationTtl: 300,
        });

        // Add to Queue if needed
        await env.LOGOUT_RETRY_QUEUE.send({
          type: 'backchannel_logout_retry',
          clientId,
          userId,
          sessionId,
          attempt,
          scheduledAt: Date.now(),
        });
      },
    })
  );

  // 3. Return response immediately
  return c.redirect(postLogoutRedirectUri, 302);
}
```

### 6.2 Retry Flow

```
┌────────────────────────────────────────────────────────────────┐
│                    Retry Flow                                   │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   waitUntil()                                                  │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │  for each client with backchannel_logout_uri:           │  │
│   │    Check pending lock (KV)                              │  │
│   │    POST logout_token → success? ✓ done                  │  │
│   │                      → fail? → retry in-process (1s)    │  │
│   │                              → still fail? → Queue      │  │
│   └─────────────────────────────────────────────────────────┘  │
│                              ↓                                 │
│   Queue Consumer (Durable Objects or scheduled worker)         │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │  Check pending lock (KV) → skip if duplicate            │  │
│   │  attempt 2: wait 5s → POST → fail? → re-queue           │  │
│   │  attempt 3: wait 30s → POST → fail? → final failure     │  │
│   │                                        ↓                │  │
│   │                              on_final_failure handling  │  │
│   │                              (log_only or alert)        │  │
│   │                              Clear pending lock         │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### 6.3 Send Service Implementation

```typescript
// packages/ar-lib-core/src/services/backchannel-logout-sender.ts

interface BackchannelLogoutResult {
  clientId: string;
  success: boolean;
  statusCode?: number;
  error?: string;
  retryScheduled?: boolean;
  duration_ms?: number;
}

export async function sendBackchannelLogout(
  env: Env,
  clientId: string,
  logoutToken: string,
  config: LogoutConfig
): Promise<BackchannelLogoutResult> {
  const startTime = Date.now();
  const client = await getClient(env, clientId);
  if (!client?.backchannel_logout_uri) {
    return { clientId, success: true }; // No URI configured = skip
  }

  try {
    const response = await fetch(client.backchannel_logout_uri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-store',
      },
      body: `logout_token=${encodeURIComponent(logoutToken)}`,
      signal: AbortSignal.timeout(config.request_timeout_ms),
    });

    const duration_ms = Date.now() - startTime;

    // 200 OK or 204 No Content is success
    if (response.status === 200 || response.status === 204) {
      return { clientId, success: true, statusCode: response.status, duration_ms };
    }

    // 400 Bad Request is not retried (RP rejected the token)
    if (response.status === 400) {
      const errorBody = await response.text().catch(() => '');
      console.warn(`Backchannel logout rejected by ${clientId}: ${errorBody}`);
      // Record failure log to DB/KV (for operational visibility)
      await recordLogoutFailure(env, clientId, {
        statusCode: response.status,
        error: 'rejected_by_rp',
        errorDetail: errorBody,
        timestamp: Date.now(),
      });
      return {
        clientId,
        success: false,
        statusCode: response.status,
        error: 'rejected_by_rp',
        retryScheduled: false,
        duration_ms,
      };
    }

    // Other errors are retry candidates
    return {
      clientId,
      success: false,
      statusCode: response.status,
      error: `HTTP ${response.status}`,
      retryScheduled: true,
      duration_ms,
    };
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    // Record failure log
    await recordLogoutFailure(env, clientId, {
      error: errorMessage,
      timestamp: Date.now(),
    });
    return {
      clientId,
      success: false,
      error: errorMessage,
      retryScheduled: true,
      duration_ms,
    };
  }
}

/**
 * Record failure log to KV (for operational visibility)
 * Design Review [RECOMMENDED]: Visualize "Failed RP list" and "Last error" in Admin UI
 */
async function recordLogoutFailure(
  env: Env,
  clientId: string,
  failure: {
    statusCode?: number;
    error: string;
    errorDetail?: string;
    timestamp: number;
  }
): Promise<void> {
  const key = `logout:failures:${clientId}`;
  // Keep only the latest failure (TTL: 7 days)
  await env.SETTINGS.put(key, JSON.stringify(failure), {
    expirationTtl: 7 * 24 * 60 * 60,
  });
}
```

---

## 7. Admin API Design

### 7.1 Get/Update Settings

```http
# Get settings
GET /admin/settings/logout
Authorization: Bearer {admin_token}

Response:
{
  "backchannel": {
    "enabled": true,
    "logout_token_exp_seconds": 120,
    "include_sub_claim": true,
    "include_sid_claim": true,
    "request_timeout_ms": 5000,
    "retry": {
      "max_attempts": 3,
      "initial_delay_ms": 1000,
      "max_delay_ms": 30000,
      "backoff_multiplier": 2
    },
    "on_final_failure": "log_only"
  },
  "frontchannel": {
    "enabled": true,
    "iframe_timeout_ms": 3000,
    "max_concurrent_iframes": 10
  },
  "session_management": {
    "enabled": true,
    "check_session_iframe_enabled": true
  }
}

# Update settings (partial update)
PATCH /admin/settings/logout
Authorization: Bearer {admin_token}
Content-Type: application/json

{
  "backchannel": {
    "logout_token_exp_seconds": 180,
    "retry": {
      "max_attempts": 5
    },
    "on_final_failure": "alert"
  }
}

Response: 200 OK
{
  "updated": true,
  "settings": { ... }
}
```

### 7.2 Client Settings Update

```http
# Configure client Logout URIs
PATCH /admin/clients/{client_id}
Authorization: Bearer {admin_token}
Content-Type: application/json

{
  "backchannel_logout_uri": "https://rp.example.com/logout/backchannel",
  "backchannel_logout_session_required": true,
  "frontchannel_logout_uri": "https://rp.example.com/logout/frontchannel",
  "frontchannel_logout_session_required": false
}
```

> **Design Review [OPTIONAL]**: Implement the following when setting `backchannel_logout_uri` for better UX
>
> - HTTPS validation (only allow localhost exception)
> - Reachability check (optional, can be disabled in settings)

### 7.3 Dynamic Client Registration Support

```http
# RFC 7591 Dynamic Client Registration
POST /register
Content-Type: application/json

{
  "redirect_uris": ["https://rp.example.com/callback"],
  "client_name": "Example RP",
  "backchannel_logout_uri": "https://rp.example.com/logout/backchannel",
  "backchannel_logout_session_required": true,
  "frontchannel_logout_uri": "https://rp.example.com/logout/frontchannel",
  "frontchannel_logout_session_required": false
}
```

### 7.4 Logout Failure Status Visibility (Operational Feature)

```http
# Get list of failed RPs
GET /admin/logout/failures
Authorization: Bearer {admin_token}

Response:
{
  "failures": [
    {
      "client_id": "client_abc",
      "client_name": "Example RP",
      "last_failure": {
        "timestamp": 1703318400000,
        "statusCode": 503,
        "error": "HTTP 503",
        "errorDetail": "Service Unavailable"
      }
    }
  ],
  "total": 1
}

# Clear failure history for specific client
DELETE /admin/logout/failures/{client_id}
Authorization: Bearer {admin_token}

Response: 204 No Content
```

---

## 8. Type Definitions

### 8.1 Logout-Related Types

```typescript
// packages/ar-lib-core/src/types/logout.ts

/**
 * Logout Token Claims
 * OIDC Back-Channel Logout 1.0 Section 2.4
 *
 * Design Review [REQUIRED]: aud is fixed to single string
 * - Backchannel Logout Token is principally for a "single RP"
 * - Using string[] causes bugs due to RP implementation differences
 */
export interface LogoutTokenClaims {
  iss: string;
  aud: string; // Single client_id (not an array)
  iat: number;
  exp: number;
  jti: string;
  events: {
    'http://schemas.openid.net/event/backchannel-logout': Record<string, never>;
  };
  sub?: string;
  sid?: string;
  // nonce MUST NOT be present
}

/**
 * Backchannel Logout Configuration
 */
export interface BackchannelLogoutConfig {
  enabled: boolean;
  logout_token_exp_seconds: number;
  include_sub_claim: boolean;
  include_sid_claim: boolean;
  request_timeout_ms: number;
  retry: RetryConfig;
  on_final_failure: 'log_only' | 'alert';
}

/**
 * Retry Configuration
 */
export interface RetryConfig {
  max_attempts: number;
  initial_delay_ms: number;
  max_delay_ms: number;
  backoff_multiplier: number;
}

/**
 * Frontchannel Logout Configuration
 *
 * Note [RECOMMENDED]: iframe_timeout_ms is for UX control, not a security guarantee
 * - It's impossible for OP to detect iframe load success/failure (fundamental Frontchannel limitation)
 * - Use Backchannel Logout when security is important
 */
export interface FrontchannelLogoutConfig {
  enabled: boolean;
  iframe_timeout_ms: number;
  max_concurrent_iframes: number;
}

/**
 * Session Management Configuration
 *
 * Note: Session Management is treated as a Conformance-only feature
 * - Increasing environments where it doesn't work in production
 * - Can be disabled via check_session_iframe_enabled
 */
export interface SessionManagementConfig {
  enabled: boolean;
  check_session_iframe_enabled: boolean;
}

/**
 * Integrated Logout Configuration
 */
export interface LogoutConfig {
  backchannel: BackchannelLogoutConfig;
  frontchannel: FrontchannelLogoutConfig;
  session_management: SessionManagementConfig;
}

/**
 * Logout Send Result
 */
export interface LogoutSendResult {
  clientId: string;
  success: boolean;
  method: 'backchannel' | 'frontchannel';
  statusCode?: number;
  error?: string;
  retryScheduled?: boolean;
  duration_ms?: number;
}

/**
 * Logout Failure Record
 */
export interface LogoutFailureRecord {
  clientId: string;
  clientName?: string;
  lastFailure: {
    timestamp: number;
    statusCode?: number;
    error: string;
    errorDetail?: string;
  };
}
```

---

## 9. Security Considerations

### 9.1 Logout Token Signature Verification

- **Required**: RP MUST verify Logout Token signature
- **Signing algorithm**: Only RS256 supported (`none` is prohibited)
- **Key**: Uses the same JWKS as ID Token signing

### 9.2 Replay Attack Prevention

```typescript
// Duplicate check using JTI cache
const jtiCacheKey = `bcl_jti:${jti}`;
const existing = await env.SETTINGS.get(jtiCacheKey);
if (existing) {
  throw new Error('Logout token replay detected');
}
await env.SETTINGS.put(jtiCacheKey, '1', {
  expirationTtl: logoutTokenExpSeconds + 60,
});
```

### 9.3 HTTPS Requirements

- `backchannel_logout_uri` requires HTTPS
- `frontchannel_logout_uri` requires HTTPS
- HTTP allowed only for localhost in development environments

### 9.4 Timeouts

- Backchannel: 5 seconds (configurable)
- Frontchannel iframe: 3 seconds (configurable)
- Prevents long blocking

### 9.5 Session Invalidation Completeness

> **Design Review [REQUIRED]**: The essence of Logout is not "notification" but **Session invalidation completeness**

After session deletion, ensure the following endpoints reliably fail:

- `/token` (Refresh Token)
- `/token` (Token Exchange)
- `/userinfo`

---

## 10. Implementation Phases

### Phase 1: Backchannel Logout Send (Priority)

1. DB migration (client field additions, session_clients table)
2. Logout Token generation logic
3. Send service implementation
4. Retry mechanism implementation (including duplicate enqueue prevention)
5. Admin API implementation
6. Testing

### Phase 2: Frontchannel Logout

1. Frontchannel send logic (iframe generation)
2. Timeout handling
3. Testing

### Phase 3: Session Management (For Conformance)

1. `/session/check` endpoint implementation
2. `session_state` parameter generation
3. Session iframe HTML
4. Testing

---

## 11. Test Plan

### 11.1 Unit Tests

- [ ] Logout Token generation
- [ ] Logout Token `aud` is always a single string
- [ ] Signature verification
- [ ] Configuration value loading (KV → Environment variables → Default)
- [ ] Retry logic
- [ ] Duplicate enqueue prevention logic

### 11.2 Integration Tests

- [ ] Backchannel Logout E2E flow
- [ ] Retry → Final failure flow
- [ ] Multiple RP simultaneous notification
- [ ] Frontchannel iframe generation

### 11.3 Session Invalidation Completeness Tests

> **Design Review [REQUIRED]**: Tests to add

- [ ] `/token` (Refresh Token) fails after session deletion
- [ ] `/token` (Token Exchange) fails after session deletion
- [ ] `/userinfo` fails after session deletion

### 11.4 Conformance Tests

- [ ] OIDC Conformance Suite: Back-Channel Logout
- [ ] OIDC Conformance Suite: Front-Channel Logout
- [ ] OIDC Conformance Suite: Session Management

---

## 12. Notes and Limitations

### 12.1 Frontchannel Logout Limitations

> **Design Review [RECOMMENDED]**: Should be documented in README / Admin UI

The iframe-based Frontchannel Logout has the following fundamental limitations:

1. **OP cannot detect success/failure**
   - Due to browser Same-Origin Policy, parent window cannot check iframe load result
   - `iframe_timeout_ms` is the "wait time limit", not a guarantee of RP processing success

2. **Third-party Cookie Restrictions**
   - In Safari, Brave, and future Chrome, cookies may not be attached to iframe requests
   - This prevents RP from identifying the session, making logout ineffective

3. **Recommendations**
   - Use **Backchannel Logout** when security is important
   - Position Frontchannel as a "best effort" for UX improvement

### 12.2 Session Management Positioning

Session Management (check_session_iframe):

- Treated as a **Conformance-only feature**
- Increasing environments where it doesn't work in production
- Can be disabled via settings (`check_session_iframe_enabled: false`)

---

## 13. References

- [OIDC Back-Channel Logout 1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html)
- [OIDC Front-Channel Logout 1.0](https://openid.net/specs/openid-connect-frontchannel-1_0.html)
- [OIDC RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)
- [OIDC Session Management 1.0](https://openid.net/specs/openid-connect-session-1_0.html)
