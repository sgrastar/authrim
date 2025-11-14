# ITP-Compliant Session Management API

## Overview

The ITP-Compliant Session Management API provides session token issuance and verification for handling Intelligent Tracking Prevention (ITP) restrictions in Safari and other privacy-focused browsers. It enables secure cross-domain session establishment without relying on third-party cookies.

**Key Features:**
- Short-lived single-use session tokens (5-minute TTL)
- ITP-compliant cross-domain session establishment
- Session status checking without iframes
- Active TTL with session refresh capability
- Integration with SessionStore Durable Object

**Use Cases:**
- Cross-domain SSO in Safari/ITP-enabled browsers
- Embedded authentication flows
- Mobile app authentication
- Session status polling

## Base URL

```
https://your-domain.com/auth/session
https://your-domain.com/session
```

## Endpoints

### 1. Issue Session Token

Issue a short-lived, single-use token for cross-domain session establishment.

**Endpoint:** `POST /auth/session/token`

**Authentication:**
Requires an active session (via cookie).

**Request Headers:**
```http
Cookie: enrai_session={session_id}
```

**Response (200 OK):**
```json
{
  "token": "550e8400-e29b-41d4-a716-446655440000",
  "expires_in": 300,
  "session_id": "session_abc123"
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `token` | string | Single-use session token (UUID) |
| `expires_in` | number | Token expiration time in seconds (300 = 5 minutes) |
| `session_id` | string | Associated session ID |

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 401 | `unauthorized` | No active session found |
| 401 | `session_not_found` | Session has expired or is invalid |
| 500 | `server_error` | Failed to issue session token |

**Example:**
```bash
curl -X POST "https://your-domain.com/auth/session/token" \
  -H "Cookie: enrai_session=session_abc123"
```

**JavaScript Usage:**
```javascript
// Issue session token for cross-domain use
async function issueSessionToken() {
  const response = await fetch('https://your-domain.com/auth/session/token', {
    method: 'POST',
    credentials: 'include' // Include cookies
  });

  const data = await response.json();
  console.log('Token:', data.token);
  console.log('Expires in:', data.expires_in, 'seconds');

  return data.token;
}
```

---

### 2. Verify Session Token

Verify a session token and optionally create a new session for the RP domain.

**Endpoint:** `POST /auth/session/verify`

**Request Body:**
```json
{
  "token": "550e8400-e29b-41d4-a716-446655440000",
  "rp_origin": "https://app.example.com"
}
```

**Request Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `token` | string | Yes | Session token from `/auth/session/token` |
| `rp_origin` | string | No | Relying Party origin (creates new session if provided) |

**Response (200 OK):**
```json
{
  "session_id": "session_xyz789",
  "user_id": "user_123",
  "expires_at": 1699651200000,
  "verified": true
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session ID (new session if `rp_origin` was provided) |
| `user_id` | string | User ID associated with the session |
| `expires_at` | number | Session expiration timestamp (Unix milliseconds) |
| `verified` | boolean | Always `true` on success |

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 400 | `invalid_request` | Token is required |
| 401 | `invalid_token` | Token not found or has expired |
| 401 | `invalid_token` | Token has already been used (single-use enforcement) |
| 401 | `session_expired` | Original session has expired |
| 500 | `server_error` | Failed to verify session token |

**Example:**
```bash
curl -X POST "https://your-domain.com/auth/session/verify" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "550e8400-e29b-41d4-a716-446655440000",
    "rp_origin": "https://app.example.com"
  }'
```

**JavaScript Usage:**
```javascript
// Verify token and establish session on RP domain
async function verifySessionToken(token, rpOrigin) {
  const response = await fetch('https://your-domain.com/auth/session/verify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      token: token,
      rp_origin: rpOrigin
    })
  });

  const data = await response.json();
  console.log('Session ID:', data.session_id);
  console.log('User ID:', data.user_id);

  return data;
}
```

---

### 3. Check Session Status

Check session validity without using iframes (ITP-compatible).

**Endpoint:** `GET /session/status`

**Authentication:**
Reads session from cookie.

**Request Headers:**
```http
Cookie: enrai_session={session_id}
```

**Response (200 OK) - Active Session:**
```json
{
  "active": true,
  "session_id": "session_abc123",
  "user_id": "user_123",
  "expires_at": 1699651200000,
  "created_at": 1699564800000
}
```

**Response (200 OK) - Inactive Session:**
```json
{
  "active": false,
  "error": "session_expired"
}
```

**Response (200 OK) - No Session:**
```json
{
  "active": false,
  "error": "no_session"
}
```

**Response Fields (Active):**
| Field | Type | Description |
|-------|------|-------------|
| `active` | boolean | Session active status |
| `session_id` | string | Session ID |
| `user_id` | string | User ID |
| `expires_at` | number | Expiration timestamp (Unix milliseconds) |
| `created_at` | number | Creation timestamp (Unix milliseconds) |

**Response Fields (Inactive):**
| Field | Type | Description |
|-------|------|-------------|
| `active` | boolean | Always `false` |
| `error` | string | Error code: `no_session`, `session_expired` |

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 500 | `server_error` | Failed to check session status |

**Example:**
```bash
curl "https://your-domain.com/session/status" \
  -H "Cookie: enrai_session=session_abc123"
```

**JavaScript Usage:**
```javascript
// Check if user has an active session
async function checkSessionStatus() {
  const response = await fetch('https://your-domain.com/session/status', {
    credentials: 'include'
  });

  const data = await response.json();

  if (data.active) {
    console.log('Active session:', data.session_id);
    console.log('User:', data.user_id);
  } else {
    console.log('No active session:', data.error);
  }

  return data.active;
}

// Poll session status every 5 minutes
setInterval(checkSessionStatus, 5 * 60 * 1000);
```

---

### 4. Refresh Session (Active TTL)

Extend session expiration time (Active Time-To-Live).

**Endpoint:** `POST /session/refresh`

**Authentication:**
Session can be provided via cookie or request body.

**Option 1: Cookie Authentication**
```http
Cookie: enrai_session={session_id}
```

**Request Body (Optional):**
```json
{
  "extend_seconds": 3600
}
```

**Option 2: Body Authentication**
```json
{
  "session_id": "session_abc123",
  "extend_seconds": 3600
}
```

**Request Fields:**
| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `session_id` | string | No* | - | Session ID (*required if not in cookie) |
| `extend_seconds` | number | No | 3600 | Seconds to extend (max 86400 = 24 hours) |

**Response (200 OK):**
```json
{
  "session_id": "session_abc123",
  "user_id": "user_123",
  "expires_at": 1699654800000,
  "extended_by": 3600,
  "message": "Session extended successfully"
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session ID |
| `user_id` | string | User ID |
| `expires_at` | number | New expiration timestamp (Unix milliseconds) |
| `extended_by` | number | Seconds extended |
| `message` | string | Success message |

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 400 | `invalid_request` | Session ID is required |
| 400 | `invalid_request` | Extension duration must be between 0 and 86400 seconds |
| 404 | `session_not_found` | Session not found or has expired |
| 500 | `server_error` | Failed to extend session |

**Example:**
```bash
# Extend session by 1 hour (via cookie)
curl -X POST "https://your-domain.com/session/refresh" \
  -H "Content-Type: application/json" \
  -H "Cookie: enrai_session=session_abc123" \
  -d '{"extend_seconds": 3600}'

# Extend session by 2 hours (via body)
curl -X POST "https://your-domain.com/session/refresh" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "session_abc123",
    "extend_seconds": 7200
  }'
```

**JavaScript Usage:**
```javascript
// Extend session on user activity
async function refreshSession(extendSeconds = 3600) {
  const response = await fetch('https://your-domain.com/session/refresh', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      extend_seconds: extendSeconds
    })
  });

  const data = await response.json();
  console.log('Session extended by', data.extended_by, 'seconds');
  console.log('New expiration:', new Date(data.expires_at));

  return data;
}

// Refresh session on user activity (e.g., mouse movement, clicks)
let activityTimer;
document.addEventListener('mousemove', () => {
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => refreshSession(3600), 60000); // Refresh after 1 min of activity
});
```

---

## ITP Cross-Domain Session Flow

### Scenario: Establishing Session on RP Domain

```
┌─────────┐                  ┌────────────┐                  ┌──────────┐
│ Browser │                  │ OP (IdP)   │                  │ RP App   │
└────┬────┘                  └─────┬──────┘                  └────┬─────┘
     │                             │                              │
     │ 1. Login at OP              │                              │
     ├────────────────────────────>│                              │
     │    (Passkey/Magic Link)     │                              │
     │                             │                              │
     │ 2. Session created          │                              │
     │<────────────────────────────┤                              │
     │    Cookie: enrai_session    │                              │
     │                             │                              │
     │ 3. Issue session token      │                              │
     ├────────────────────────────>│                              │
     │    POST /auth/session/token │                              │
     │                             │                              │
     │ 4. Token (5 min TTL)        │                              │
     │<────────────────────────────┤                              │
     │    {token: "uuid"}          │                              │
     │                             │                              │
     │ 5. Pass token to RP         │                              │
     ├─────────────────────────────┼─────────────────────────────>│
     │    (URL param, postMessage) │                              │
     │                             │                              │
     │ 6. Verify token & create RP session                        │
     │                             │<─────────────────────────────┤
     │                             │  POST /auth/session/verify   │
     │                             │  {token, rp_origin}          │
     │                             │                              │
     │                             │  7. New session for RP       │
     │                             ├─────────────────────────────>│
     │                             │  {session_id, user_id}       │
     │                             │                              │
     │ 8. RP session established   │                              │
     │<────────────────────────────┼──────────────────────────────┤
     │    Cookie: rp_session       │                              │
     │                             │                              │
```

### Implementation Example

**Step 1: Login at OP**
```javascript
// User logs in at https://auth.example.com
window.location.href = 'https://auth.example.com/auth/passkey/login';
```

**Step 2: Issue Session Token**
```javascript
// After successful login
const tokenResponse = await fetch('https://auth.example.com/auth/session/token', {
  method: 'POST',
  credentials: 'include'
});
const { token } = await tokenResponse.json();
```

**Step 3: Pass Token to RP**
```javascript
// Option A: URL parameter
window.location.href = `https://app.example.com/auth/callback?token=${token}`;

// Option B: postMessage (for iframes/popups)
window.opener.postMessage({ type: 'session_token', token }, 'https://app.example.com');
```

**Step 4: Verify Token at RP**
```javascript
// At https://app.example.com
const params = new URLSearchParams(window.location.search);
const token = params.get('token');

const verifyResponse = await fetch('https://auth.example.com/auth/session/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    token: token,
    rp_origin: 'https://app.example.com'
  })
});

const { session_id, user_id } = await verifyResponse.json();

// Store session for RP app
sessionStorage.setItem('session_id', session_id);
sessionStorage.setItem('user_id', user_id);
```

---

## Security Considerations

### Token Security
- **Single-Use Enforcement**: Each token can only be used once to prevent replay attacks
- **Short TTL**: 5-minute expiration minimizes exposure window
- **Secure Storage**: Tokens stored in KV with automatic expiration
- **No Sensitive Data**: Tokens are opaque UUIDs, not JWTs

### Session Security
- **HttpOnly Cookies**: Session cookies are HttpOnly to prevent XSS attacks
- **Secure Flag**: Cookies require HTTPS
- **SameSite=None**: Allows cross-site usage with Secure flag
- **Session Invalidation**: Instant revocation via SessionStore Durable Object

### ITP Compatibility
- **No Third-Party Cookies**: Uses token-based flow instead
- **No iframes**: Status checking via direct API calls
- **Cross-Domain Support**: Separate sessions for each RP domain

---

## Rate Limiting

No rate limiting is currently enforced on these endpoints. However, the following limits are recommended for production:

- **Issue Token**: 10 requests per minute per session
- **Verify Token**: 20 requests per minute per IP
- **Session Status**: 60 requests per minute per session
- **Refresh Session**: 10 requests per minute per session

---

## Best Practices

### 1. Token Handling
```javascript
// GOOD: Use token immediately after issuance
const token = await issueToken();
await verifyToken(token);

// BAD: Storing token for later use (may expire)
localStorage.setItem('token', token); // Don't do this!
```

### 2. Session Refresh
```javascript
// GOOD: Refresh on user activity
const refreshOnActivity = debounce(() => refreshSession(3600), 60000);
document.addEventListener('click', refreshOnActivity);

// BAD: Refreshing too frequently
setInterval(() => refreshSession(3600), 1000); // Don't do this!
```

### 3. Status Checking
```javascript
// GOOD: Check status periodically
setInterval(checkSessionStatus, 5 * 60 * 1000); // Every 5 minutes

// BAD: Checking too frequently
setInterval(checkSessionStatus, 1000); // Don't do this!
```

---

## Related Documentation

- [SessionStore Durable Object](../durable-objects/SessionStore.md)
- [OAuth Consent API](./consent.md)
- [Logout API](./logout.md)
- [Admin Session Management](../admin/sessions.md)
