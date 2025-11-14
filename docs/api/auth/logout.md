# Logout API

## Overview

The Logout API implements OpenID Connect logout mechanisms, supporting both front-channel (browser-initiated) and back-channel (server-to-server) logout flows. It enables secure session termination and supports single logout across multiple relying parties.

**Key Features:**
- Front-channel logout with redirect support
- Back-channel logout (RFC 8725 compliant)
- ID token hint validation
- Session invalidation in SessionStore
- Post-logout redirect URI validation
- Multi-device session cleanup

**Standards Compliance:**
- OpenID Connect Session Management 1.0
- OpenID Connect Front-Channel Logout 1.0
- OpenID Connect Back-Channel Logout 1.0 (RFC 8725)

## Base URL

```
https://your-domain.com/logout
```

## Endpoints

### 1. Front-Channel Logout

Browser-initiated logout with optional redirect to post-logout URI.

**Endpoint:** `GET /logout`

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id_token_hint` | string | No | ID token previously issued to the RP |
| `post_logout_redirect_uri` | string | No | Where to redirect after logout |
| `state` | string | No | Opaque value to maintain state between request and callback |

**Authentication:**
Session can be provided via cookie.

**Request Headers:**
```http
Cookie: enrai_session={session_id}
```

**Response (302 Found):**
Redirects to `post_logout_redirect_uri` (if provided) or default logout page.

**Response Headers:**
```http
Location: https://yourapp.com/logged-out?state=xyz123
Set-Cookie: enrai_session=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0
```

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 400 | `invalid_request` | `post_logout_redirect_uri` is not registered for this client |
| 500 | `server_error` | Failed to process logout request |

**Example:**
```bash
# Basic logout
curl -L "https://your-domain.com/logout" \
  -H "Cookie: enrai_session=session_abc123"

# Logout with ID token hint and redirect
curl -L "https://your-domain.com/logout?id_token_hint=eyJhbGc...&post_logout_redirect_uri=https://yourapp.com/bye&state=xyz123" \
  -H "Cookie: enrai_session=session_abc123"
```

**JavaScript Usage:**
```javascript
// Simple logout
function logout() {
  window.location.href = 'https://your-domain.com/logout';
}

// Logout with redirect
function logoutWithRedirect(idToken, redirectUri, state) {
  const params = new URLSearchParams({
    id_token_hint: idToken,
    post_logout_redirect_uri: redirectUri,
    state: state
  });

  window.location.href = `https://your-domain.com/logout?${params.toString()}`;
}

// Example usage
logoutWithRedirect(
  localStorage.getItem('id_token'),
  'https://yourapp.com/logged-out',
  crypto.randomUUID()
);
```

**Behavior:**

1. **ID Token Validation** (if `id_token_hint` provided):
   - Validates JWT signature using JWKS
   - Extracts `sub` (user ID) and `aud` (client ID)
   - Continues logout even if validation fails (non-blocking)

2. **Session Invalidation**:
   - Retrieves session ID from cookie
   - Invalidates session in SessionStore Durable Object
   - Deletes session from D1 database
   - Clears session cookie

3. **Redirect URI Validation** (if `post_logout_redirect_uri` provided):
   - Checks if URI is registered for the client
   - Returns error if not registered
   - Allows default logout page if not provided

4. **Redirect**:
   - Redirects to `post_logout_redirect_uri` with `state` parameter
   - Defaults to `{ISSUER_URL}/logged-out` if not provided

---

### 2. Back-Channel Logout

Server-to-server logout notification (RFC 8725).

**Endpoint:** `POST /logout/backchannel`

**Authentication:**
HTTP Basic Authentication (client credentials).

**Request Headers:**
```http
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)
```

**Request Body:**
```
logout_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Form Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `logout_token` | string | Yes | JWT logout token |

**Logout Token Claims:**
```json
{
  "iss": "https://your-domain.com",
  "sub": "user_123",
  "aud": "client_abc",
  "iat": 1699564800,
  "jti": "unique_token_id",
  "events": {
    "http://schemas.openid.net/event/backchannel-logout": {}
  },
  "sid": "session_abc123"
}
```

**Required Claims:**
| Claim | Description |
|-------|-------------|
| `iss` | Issuer identifier (must match OP's issuer URL) |
| `sub` | Subject identifier (user ID) |
| `aud` | Audience (client ID) |
| `iat` | Issued at timestamp |
| `jti` | Unique identifier for the token |
| `events` | Must contain `http://schemas.openid.net/event/backchannel-logout` |

**Optional Claims:**
| Claim | Description |
|-------|-------------|
| `sid` | Session ID (if provided, only this session is invalidated) |

**Prohibited Claims:**
| Claim | Reason |
|-------|--------|
| `nonce` | Must not be present per OpenID Connect Back-Channel Logout spec |

**Response (200 OK):**
Empty body (success).

**Response Headers:**
```http
Content-Length: 0
```

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 400 | `invalid_request` | `logout_token` is required |
| 400 | `invalid_request` | Invalid logout token |
| 400 | `invalid_request` | `logout_token` must contain `sub` claim |
| 400 | `invalid_request` | `logout_token` must contain backchannel-logout event |
| 400 | `invalid_request` | `logout_token` must not contain `nonce` claim |
| 401 | `invalid_client` | Invalid client credentials |
| 500 | `server_error` | Failed to process logout request |

**Example:**
```bash
# Logout specific session
curl -X POST "https://your-domain.com/logout/backchannel" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "Authorization: Basic $(echo -n 'client_id:client_secret' | base64)" \
  -d "logout_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**JavaScript Usage (Node.js):**
```javascript
const jwt = require('jsonwebtoken');
const axios = require('axios');

async function sendBackChannelLogout(userId, sessionId, clientId, clientSecret) {
  // Create logout token
  const logoutToken = jwt.sign(
    {
      iss: 'https://your-domain.com',
      sub: userId,
      aud: clientId,
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
      events: {
        'http://schemas.openid.net/event/backchannel-logout': {}
      },
      sid: sessionId
    },
    privateKey,
    { algorithm: 'RS256' }
  );

  // Send logout notification
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await axios.post(
    'https://your-domain.com/logout/backchannel',
    `logout_token=${logoutToken}`,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      }
    }
  );

  console.log('Logout notification sent:', response.status);
}
```

**Behavior:**

1. **Client Authentication**:
   - Validates HTTP Basic Auth credentials
   - Extracts client ID and secret
   - Verifies against D1 database
   - Returns 401 if invalid

2. **Logout Token Validation**:
   - Fetches JWKS from KeyManager Durable Object
   - Verifies JWT signature
   - Validates required claims (`iss`, `sub`, `aud`, `iat`, `jti`, `events`)
   - Ensures `nonce` claim is not present
   - Returns 400 if validation fails

3. **Session Invalidation**:
   - If `sid` (session ID) provided: Invalidates specific session
   - If `sid` not provided: Invalidates all sessions for user
   - Deletes from SessionStore Durable Object
   - Deletes from D1 database

4. **Response**:
   - Returns 200 with empty body on success
   - Logs logout event to console

---

## Logout Flows

### Front-Channel Logout Flow

```
┌─────────┐              ┌──────────┐              ┌────────────┐
│ Browser │              │ RP App   │              │ OP (IdP)   │
└────┬────┘              └────┬─────┘              └─────┬──────┘
     │                        │                          │
     │ 1. User clicks logout │                          │
     ├──────────────────────>│                          │
     │                        │                          │
     │ 2. Redirect to OP logout                         │
     │                        ├─────────────────────────>│
     │    GET /logout?id_token_hint=...&post_logout_redirect_uri=...
     │                        │                          │
     │ 3. Invalidate session  │                          │
     │                        │<─────────────────────────┤
     │                        │  Clear cookie            │
     │                        │                          │
     │ 4. Redirect to RP      │                          │
     │<───────────────────────┼──────────────────────────┤
     │    302 Location: post_logout_redirect_uri        │
     │                        │                          │
     │ 5. RP clears state     │                          │
     ├──────────────────────>│                          │
     │    Clear localStorage  │                          │
     │                        │                          │
```

### Back-Channel Logout Flow (Multi-RP)

```
┌──────────┐         ┌────────────┐         ┌──────────┐         ┌──────────┐
│ RP App 1 │         │ OP (IdP)   │         │ RP App 2 │         │ RP App 3 │
└────┬─────┘         └─────┬──────┘         └────┬─────┘         └────┬─────┘
     │                     │                     │                     │
     │ 1. User logout      │                     │                     │
     ├────────────────────>│                     │                     │
     │  Front-channel      │                     │                     │
     │                     │                     │                     │
     │ 2. OP invalidates session                 │                     │
     │                     │                     │                     │
     │ 3. Send back-channel logout to all RPs   │                     │
     │                     ├────────────────────>│                     │
     │                     │  POST /logout/backchannel                 │
     │                     │  (logout_token)     │                     │
     │                     │                     │                     │
     │                     ├──────────────────────────────────────────>│
     │                     │  POST /logout/backchannel                 │
     │                     │  (logout_token)                           │
     │                     │                     │                     │
     │                     │ 4. RPs invalidate user sessions           │
     │                     │<────────────────────┤                     │
     │                     │  200 OK             │                     │
     │                     │                     │                     │
     │                     │<──────────────────────────────────────────┤
     │                     │  200 OK                                   │
     │                     │                     │                     │
     │ 5. Redirect user    │                     │                     │
     │<────────────────────┤                     │                     │
     │  post_logout_redirect_uri                 │                     │
     │                     │                     │                     │
```

---

## Security Considerations

### Front-Channel Security
- **ID Token Validation**: Verifies JWT signature to prevent token forgery
- **Redirect URI Validation**: Only allows registered URIs to prevent open redirects
- **State Parameter**: Maintains state between request and callback
- **Session Cookie Clearing**: Ensures complete logout

### Back-Channel Security
- **Client Authentication**: HTTP Basic Auth prevents unauthorized logout requests
- **JWT Signature Validation**: Prevents token tampering
- **Single-Use JTI**: Prevents replay attacks (should be tracked in production)
- **No Nonce**: Enforces spec compliance
- **Logout Token vs ID Token**: Separate token types prevent confusion attacks

### Session Invalidation
- **Instant Revocation**: SessionStore Durable Object provides immediate invalidation
- **Multi-Source Cleanup**: Deletes from both memory (DO) and database (D1)
- **Audit Trail**: Logs logout events for security monitoring

---

## Error Handling

### Common Error Scenarios

**1. Invalid Post-Logout Redirect URI**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "invalid_request",
  "error_description": "post_logout_redirect_uri is not registered for this client"
}
```

**2. Invalid Logout Token**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "invalid_request",
  "error_description": "Invalid logout_token"
}
```

**3. Invalid Client Credentials**
```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": "invalid_client",
  "error_description": "Invalid client credentials"
}
```

---

## Best Practices

### 1. Front-Channel Logout
```javascript
// GOOD: Include ID token hint for better tracking
function logout() {
  const idToken = localStorage.getItem('id_token');
  const params = new URLSearchParams({
    id_token_hint: idToken,
    post_logout_redirect_uri: window.location.origin + '/logged-out',
    state: crypto.randomUUID()
  });

  // Clear local state
  localStorage.clear();
  sessionStorage.clear();

  // Redirect to OP logout
  window.location.href = `https://auth.example.com/logout?${params}`;
}

// BAD: Not clearing local state
function logout() {
  window.location.href = 'https://auth.example.com/logout';
  // localStorage still contains tokens!
}
```

### 2. Back-Channel Logout
```javascript
// GOOD: Implement back-channel endpoint at RP
app.post('/logout/backchannel', async (req, res) => {
  const { logout_token } = req.body;

  try {
    // Verify logout token
    const payload = await verifyLogoutToken(logout_token);

    // Invalidate session
    const sessionId = payload.sid;
    const userId = payload.sub;

    if (sessionId) {
      await invalidateSession(sessionId);
    } else {
      await invalidateAllUserSessions(userId);
    }

    res.status(200).send();
  } catch (error) {
    res.status(400).json({ error: 'invalid_request' });
  }
});
```

### 3. Logout Token Creation
```javascript
// GOOD: Include all required claims
const logoutToken = {
  iss: 'https://auth.example.com',
  sub: userId,
  aud: clientId,
  iat: Math.floor(Date.now() / 1000),
  jti: crypto.randomUUID(),
  events: {
    'http://schemas.openid.net/event/backchannel-logout': {}
  },
  sid: sessionId // Optional
};

// BAD: Missing required claims
const logoutToken = {
  sub: userId,
  sid: sessionId
  // Missing: iss, aud, iat, jti, events
};
```

---

## Related Documentation

- [OpenID Connect Session Management](https://openid.net/specs/openid-connect-session-1_0.html)
- [OpenID Connect Front-Channel Logout](https://openid.net/specs/openid-connect-frontchannel-1_0.html)
- [OpenID Connect Back-Channel Logout (RFC 8725)](https://openid.net/specs/openid-connect-backchannel-1_0.html)
- [Session Management API](./session-management.md)
- [Admin Session Management](../admin/sessions.md)
- [SessionStore Durable Object](../durable-objects/SessionStore.md)
